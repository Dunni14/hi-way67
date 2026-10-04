// Everything spoken to the driver goes through here, one item at a time.
// - Next item starts when the phone reports `speak_done` (or a timeout).
// - Delivery pauses briefly after a hard-braking event.
// - Priority items (alerts, roasts while drowsy) jump the line.
import { randomUUID } from "node:crypto";
import { tts } from "./elevenlabs.ts";
import { sendToPhone } from "../ws/server.ts";
import type { SpeakContext, Tier } from "../ws/protocol.ts";

export type SpeakItem = {
  text: string;
  tier?: Tier | 0;
  context: SpeakContext;
  listenAfterMs?: number;
  priority?: boolean;
  /** ElevenLabs voice to use instead of the default (e.g. a family member's voice). */
  voiceId?: string;
  /** Called once the phone is done with it (speak_done, a timeout, or the phone not connected). */
  onDone?: () => void;
};

const HARD_BRAKE_PAUSE_MS = 10_000;

class DriverQueue {
  private items: SpeakItem[] = [];
  private inFlight: { id: string; timer: NodeJS.Timeout; onDone?: () => void } | null = null;
  private pausedUntil = 0;
  private resumeTimer: NodeJS.Timeout | null = null;

  /** Context of the most recent item handed to the phone. */
  lastContext: SpeakContext | null = null;

  enqueue(item: SpeakItem) {
    if (item.priority) this.items.unshift(item);
    else this.items.push(item);
    void this.pump();
  }

  /** Drop queued (not yet spoken) items, e.g. once the driver has stopped. */
  clear() {
    this.items = [];
  }

  pause(ms = HARD_BRAKE_PAUSE_MS) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => void this.pump(), this.pausedUntil - Date.now());
  }

  done(id: string) {
    if (this.inFlight?.id !== id) return;
    clearTimeout(this.inFlight.timer);
    const onDone = this.inFlight.onDone;
    this.inFlight = null;
    onDone?.();
    void this.pump();
  }

  get length() {
    return this.items.length;
  }

  private async pump() {
    if (this.inFlight || Date.now() < this.pausedUntil) return;
    const item = this.items.shift();
    if (!item) return;

    const id = randomUUID();
    const listenAfterMs = item.listenAfterMs ?? 0;
    // Hold the slot while TTS runs so a second pump can't overtake us.
    this.inFlight = { id, timer: setTimeout(() => this.done(id), estimateMs(item.text) + listenAfterMs + 3000), onDone: item.onDone };

    let audio = "";
    try {
      audio = (await tts(item.text, item.tier ?? 0, item.voiceId)).toString("base64");
    } catch (err) {
      console.error("[voice] TTS failed, sending text only:", (err as Error).message);
    }
    this.lastContext = item.context;
    console.log(`[voice] speak (${item.context}): ${item.text}`);
    if (!sendToPhone({ type: "speak", id, text: item.text, tier: item.tier ?? 0, audio, listenAfterMs, context: item.context })) {
      this.done(id);
    }
  }
}

/** Rough speech duration: ~15 characters per second. */
function estimateMs(text: string) {
  return Math.max(2000, (text.length / 15) * 1000);
}

export const driverQueue = new DriverQueue();
