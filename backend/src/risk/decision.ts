// Decision tree (README §3), stateful over successive 10 s windows.
//
//   R < 40         nothing (the caller logs)
//   40 ≤ R < 70    calm check-in (drowsy) / calm reminder (reckless)
//   70 ≤ R < 85    firm warning; drowsy also routes to a rest stop; kids -> next tier up
//   R ≥ 85         urgent pull-over, or 70+ held for 2 min; notify contacts / ask permission
//
// Rules: a tier must hold 15 s before it fires; 2 min cooldown per tier.
import type { Dominant, Score } from "./model.ts";

export type AlertTier = 40 | 70 | 85;

export type Decision = {
  tier: AlertTier;
  dominant: Dominant;
  R: number;
  /** Why this tier: plain score, kids bump from 70, or 70+ sustained for 2 min. */
  reason: "score" | "kids_bump" | "sustained";
  voice: { tone: "calm" | "firm" | "urgent"; intent: "check_in" | "slow_down" | "warn" | "pull_over" };
  offerMusicOrRest: boolean; // tier 40 drowsy
  routeToRestStop: boolean; // tier 70 drowsy
  /** Tier 85 only: message contacts now, or ask the driver first. */
  notify: "contacts" | "ask_permission" | null;
};

export const DECISION = {
  windowMs: 10_000,
  holdMs: 15_000,
  cooldownMs: 2 * 60_000,
  sustainedMs: 2 * 60_000,
  tiers: [40, 70, 85] as const,
};

const tierOf = (R: number): 0 | AlertTier => (R >= 85 ? 85 : R >= 70 ? 70 : R >= 40 ? 40 : 0);

export class DecisionTree {
  /** Start of the current unbroken run with tier >= key. */
  private since = new Map<AlertTier, number>();
  private lastFired = new Map<AlertTier, number>();

  reset() {
    this.since.clear();
    this.lastFired.clear();
  }

  /**
   * Feed one scored window. `ts` is the END of the window; the window is
   * assumed to cover the `windowMs` before it, so two consecutive windows
   * (20 s of evidence) satisfy the 15 s hold.
   */
  step(ts: number, s: Score, o: { kidsInCar: boolean; sharingOn: boolean }): Decision | null {
    const raw = tierOf(s.R);
    const kidsBump = raw === 70 && o.kidsInCar;
    const t: 0 | AlertTier = kidsBump ? 85 : raw;

    for (const level of DECISION.tiers) {
      if (t >= level) {
        if (!this.since.has(level)) this.since.set(level, ts - DECISION.windowMs);
      } else this.since.delete(level);
    }

    const held = (level: AlertTier, ms: number) => ts - (this.since.get(level) ?? ts) >= ms;
    let tier: AlertTier | 0 = 0;
    let reason: Decision["reason"] = "score";
    for (const level of [85, 70, 40] as const) {
      if (held(level, DECISION.holdMs)) {
        tier = level;
        if (level === 85 && kidsBump) reason = "kids_bump";
        break;
      }
    }
    if (held(70, DECISION.sustainedMs) && tier < 85) {
      tier = 85;
      reason = "sustained";
    }
    if (tier === 0) return null;

    // Cooldown per tier; also don't step back down right after a higher tier spoke.
    for (const level of DECISION.tiers) {
      const at = this.lastFired.get(level);
      if (level >= tier && at != null && ts - at < DECISION.cooldownMs) return null;
    }
    this.lastFired.set(tier, ts);
    return build(tier, s, reason, o.sharingOn);
  }
}

function build(tier: AlertTier, s: Score, reason: Decision["reason"], sharingOn: boolean): Decision {
  const drowsy = s.dominant === "drowsy";
  return {
    tier,
    dominant: s.dominant,
    R: s.R,
    reason,
    voice:
      tier === 85
        ? { tone: "urgent", intent: "pull_over" }
        : tier === 70
          ? { tone: "firm", intent: "warn" }
          : { tone: "calm", intent: drowsy ? "check_in" : "slow_down" },
    offerMusicOrRest: tier === 40 && drowsy,
    routeToRestStop: tier === 70 && drowsy,
    notify: tier === 85 ? (sharingOn ? "contacts" : "ask_permission") : null,
  };
}
