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

/** Spoken lines for the bandit's interventions (tier 1/2). Templates, like the alerts. */
const INTERVENTION_LINES: Record<string, string[]> = {
  calm_checkin: ["You seem tired. How are you feeling?"],
  start_conversation: ["Let's chat for a minute to keep you sharp. What's the best thing you ate this week?"],
  suggest_music: ["Let's put on something upbeat to keep you sharp."],
  suggest_rest_stop: ["You look tired. Want me to find the nearest rest stop?"],
  calm_slowdown: ["Easy there. Let's ease off the gas a little."],
  breathing_prompt: ["Let's take two slow breaths together. In through the nose, and slowly out. Once more."],
  firm_warning: ["Slow down and focus on the road right now. This is not safe."],
  family_voice_warning: ["Hey, it's us. Please slow down and be safe. We want you home in one piece."],
};

/** Letter grade for the trip so far, from its peak risk (same cut-offs as the tiers). */
export const gradeOf = (maxR: number) => (maxR >= 85 ? "D" : maxR >= 70 ? "C" : maxR >= 40 ? "B" : "A");

/** Line for an intervention id, or null when we have no script for it (caller falls back to `alertLine`). */
export function interventionLine(id: string, opts: { grade?: string } = {}): string | null {
  if (id === "report_card_reminder") return `This trip is scoring a ${opts.grade ?? "B"} so far. Let's bring it back up.`;
  const lines = INTERVENTION_LINES[id];
  return lines ? pick(lines) : null;
}

/** Interventions whose script ends in a yes/no question the existing "yes -> navigate to a rest stop" handler can answer. */
export const ASKS_REST_STOP = new Set(["suggest_rest_stop"]);

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
