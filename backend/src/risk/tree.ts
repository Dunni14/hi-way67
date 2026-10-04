// Decision tree (README §3). Stateful because it needs time: an alert must
// hold for 15 s before firing, repeats are rate limited, and 70+ sustained for
// 2 minutes escalates to the top tier. Pure: all time comes from the caller.
import type { Dominant, SharingMode, Tier } from "../ws/protocol.ts";

export const HOLD_MS = 15_000;
export const COOLDOWN_MS = 120_000;
export const SUSTAIN_MS = 120_000;
/** After "I'm fine", stay quiet on tiers below 85 for this long. */
export const BACKOFF_MS = 5 * 60_000;

const THRESHOLDS = [40, 70, 85] as const;

export type Voice = "checkin" | "reminder" | "warning" | "urgent";
export type NotifyAction = "none" | "send" | "ask";

export type Decision = {
  tier: Tier;
  dominant: Dominant;
  R: number;
  voice: Voice;
  /** Drowsy 70: route the driver to the nearest rest stop. */
  routeRestStop: boolean;
  /** 85: message contacts now ("send"), or ask the driver first ("ask"). */
  notify: NotifyAction;
  /** Why this tier fired: shown in logs and the debug screen. */
  reason: string;
};

export type TreeInput = {
  ts: number;
  R: number;
  drowsy: number;
  reckless: number;
  kidsInCar: boolean;
  sharing: SharingMode;
};

export class DecisionTree {
  /** When R first reached each threshold, continuously. null = currently below. */
  private since: Record<number, number | null> = { 40: null, 70: null, 85: null };
  private lastFired: { tier: Tier; at: number } | null = null;
  private backoffUntil = 0;

  reset() {
    this.since = { 40: null, 70: null, 85: null };
    this.lastFired = null;
    this.backoffUntil = 0;
  }

  /** Driver said "I'm fine": back off on non-urgent tiers. */
  dismiss(now: number) {
    this.backoffUntil = now + BACKOFF_MS;
  }

  step(i: TreeInput): Decision | null {
    for (const t of THRESHOLDS) this.since[t] = i.R >= t ? (this.since[t] ?? i.ts) : null;

    const held = (t: number) => this.since[t] !== null && i.ts - this.since[t]! >= HOLD_MS;
    const dominant: Dominant = i.drowsy >= i.reckless ? "drowsy" : "reckless";

    // Highest tier whose hold condition is met.
    let tier: Tier | null = null;
    let reason = "";
    if (held(85)) {
      tier = 85;
      reason = "R ≥ 85 held 15 s";
    } else if (this.since[70] !== null && i.ts - this.since[70]! >= SUSTAIN_MS) {
      tier = 85;
      reason = "R ≥ 70 sustained 2 min";
    } else if (held(70)) {
      tier = i.kidsInCar ? 85 : 70;
      reason = i.kidsInCar ? "R ≥ 70 held 15 s, kids in car → next tier" : "R ≥ 70 held 15 s";
    } else if (held(40)) {
      tier = 40;
      reason = "R ≥ 40 held 15 s";
    }
    if (tier === null) return null;

    // Rate limit: nothing at or below the last fired tier inside the cooldown.
    if (this.lastFired && tier <= this.lastFired.tier && i.ts - this.lastFired.at < COOLDOWN_MS) return null;
    // "I'm fine" silences everything except the emergency tier.
    if (tier < 85 && i.ts < this.backoffUntil) return null;

    this.lastFired = { tier, at: i.ts };
    return {
      tier,
      dominant,
      R: i.R,
      reason,
      voice: tier === 85 ? "urgent" : tier === 70 ? "warning" : dominant === "drowsy" ? "checkin" : "reminder",
      routeRestStop: tier === 70 && dominant === "drowsy",
      notify: tier < 85 ? "none" : i.sharing === "never" ? "ask" : "send",
    };
  }
}
