// WebSocket contract between the Android app and this backend.
// Every frame is a single JSON object with a `type` field.
// Share this file (or PROTOCOL.md) with the Android side; keep them in sync.
import { z } from "zod";

export const SharingMode = z.enum(["always", "high_only", "never"]);
export type SharingMode = z.infer<typeof SharingMode>;

export const Tier = z.union([z.literal(40), z.literal(70), z.literal(85)]);
export type Tier = z.infer<typeof Tier>;

export const Dominant = z.enum(["drowsy", "reckless"]);
export type Dominant = z.infer<typeof Dominant>;

export const DriverEvent = z.enum(["yawn", "nod", "hard_brake", "swerve"]);
export type DriverEvent = z.infer<typeof DriverEvent>;

export const SpeakContext = z.enum(["checkin", "after_message", "permission", "roast", "info"]);
export type SpeakContext = z.infer<typeof SpeakContext>;

// ---- phone -> backend ------------------------------------------------------

/** Raw signals for one window, named as the risk engine's SignalWindow (src/risk/types.ts). Missing = unknown. */
export const WindowSignals = z.object({
  face_visible: z.boolean().nullish(),
  heart_rate: z.number().nullish(),
  breathing_rate: z.number().nullish(),
  engagement: z.number().nullish(),
  eye_closure_frac: z.number().nullish(), // share of the window with eyes closed, 0..1
  longest_eye_closure_s: z.number().nullish(), // longest continuous closure in the window
  yawns: z.number().nullish(),
  emotion_stress: z.number().nullish(),
  gaze_off_road_s: z.number().nullish(),
  phone_in_hand: z.boolean().nullish(),
  hard_brakes: z.number().nullish(),
  swerves: z.number().nullish(),
  speed_mph: z.number().nullish(),
  speed_limit_mph: z.number().nullish(),
});
export type WindowSignals = z.infer<typeof WindowSignals>;

export const PhoneMsg = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    driverName: z.string().optional(),
    sharingMode: SharingMode.default("high_only"),
    kidsInCar: z.boolean().default(false),
    shareLocation: z.boolean().default(true), // false: no lat/lon ever goes to the iMessage agent
  }),
  z.object({
    type: z.literal("settings"),
    sharingMode: SharingMode.optional(),
    kidsInCar: z.boolean().optional(),
    shareLocation: z.boolean().optional(),
  }),
  z.object({ type: z.literal("trip_start") }),
  z.object({ type: z.literal("trip_end") }),
  // One 10 s window of raw driver signals. The backend's risk engine scores it
  // (src/risk) and decides every alert; the phone only senses and displays.
  z.object({
    type: z.literal("risk_window"),
    ts: z.number(), // epoch ms (real time), end of the window
    speed: z.number().default(0), // mph
    lat: z.number().optional(),
    lon: z.number().optional(),
    events: z.array(DriverEvent).default([]),
    signals: WindowSignals,
  }),
  // Speech-to-text result. `context` echoes the `speak.context` the phone was
  // listening after, or "free" for push-to-talk / wake word.
  z.object({
    type: z.literal("utterance"),
    text: z.string(),
    context: z.enum(["checkin", "after_message", "permission", "roast", "free"]).default("free"),
  }),
  // Phone finished playing a `speak` (and its listen window, if any).
  z.object({ type: z.literal("speak_done"), id: z.string() }),
  // PNG of the phone's end-of-trip summary card, sent right after `trip_end`. The backend
  // forwards it to the contacts with a one-line caption (never when sharing is "never").
  z.object({ type: z.literal("trip_recap"), image: z.string().min(1).max(2_000_000) }), // base64
]);
export type PhoneMsg = z.infer<typeof PhoneMsg>;

// ---- backend -> phone ------------------------------------------------------

export type BackendMsg =
  | {
      type: "speak";
      id: string;
      text: string;
      tier: Tier | 0;
      audio: string; // base64 mp3 ("" if TTS failed; phone may fall back to on-device TTS)
      listenAfterMs: number; // 0 = don't listen
      context: SpeakContext;
    }
  | { type: "navigate"; query: string }
  // Driver said "I'm fine": the engine lowered the dominant factor's weight for this driver.
  | { type: "dismissed"; factor?: string; multiplier?: number }
  // The risk engine's verdict on a risk_window (same ts), for the phone to display.
  | {
      type: "evaluation";
      ts: number;
      score: number; // 0..100
      tier: 0 | 1 | 2 | 3;
      dominant: Dominant;
      levels: Record<string, number>; // drowsy, agitated, speeding, phone, distracted, erratic (0..1)
      override: string | null; // microsleep, drowsy_sustained_3, …
      degraded: boolean; // face hidden for several windows: scoring on speed and motion only
      actions: string[]; // voice_nudge, voice_warning, voice_urgent, notify_contacts, …
      calibrating: boolean; // still inside the engine's baseline windows
    }
  | { type: "error"; message: string };
