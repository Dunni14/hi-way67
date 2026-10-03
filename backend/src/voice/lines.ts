// Spoken lines. Templates (not LLM) so alerts are instant and predictable.
import type { Dominant, Tier } from "../ws/protocol.ts";

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

const ALERTS: Record<Tier, Record<Dominant, string[]>> = {
  40: {
    drowsy: [
      "Hey, you've been yawning a bit. Want me to find a rest stop?",
      "You seem a little tired. Want me to look for somewhere to stop?",
    ],
    reckless: [
      "Easy there. Let's ease off the gas a little.",
      "Quick reminder to take it easy. No rush.",
    ],
  },
  70: {
    drowsy: [
      "You're getting drowsy. I'd really like you to stop soon. Should I route you to the nearest rest stop?",
      "Your eyes are closing more than they should. Let's find a rest stop. Say yes and I'll navigate.",
    ],
    reckless: [
      "Slow down. Your driving is getting risky.",
      "That's too aggressive. Please slow down now.",
    ],
  },
  85: {
    drowsy: [
      "You need to pull over now. You are falling asleep at the wheel.",
      "Pull over as soon as it is safe. You're too drowsy to keep driving.",
    ],
    reckless: [
      "Pull over now and take a breath. This is not safe.",
      "Stop the car when it's safe. You're driving dangerously.",
    ],
  },
};

export function alertLine(tier: Tier, dominant: Dominant): string {
  return pick(ALERTS[tier][dominant]);
}

export function permissionLine(): string {
  return "Do you want me to let your family know? Say yes or no.";
}

export function messageLine(from: string, body: string): string {
  return `Message from ${from}: ${body}`;
}

export function roastLine(from: string, body: string): string {
  return `${from} says: ${body}`;
}

export function ackLine(kind: "dismissed" | "navigating" | "sent" | "notified" | "not_notified"): string {
  switch (kind) {
    case "dismissed":
      return "Okay. I'll back off for now.";
    case "navigating":
      return "Finding the nearest rest stop.";
    case "sent":
      return "Sent.";
    case "notified":
      return "Okay, I've let them know.";
    case "not_notified":
      return "Okay, I won't tell anyone. Please stay safe.";
  }
}
