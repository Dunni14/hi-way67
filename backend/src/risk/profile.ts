// Per-driver profile that turns report-card history into the score needed to text a friend.
//
//   careIndex     0..100, higher = more careful. Moves toward each trip's card score:
//                 care <- (1 - a) * care + a * score, a = careAlpha * card.confidence (provisional cards skipped)
//   learnedShift  points added to the threshold by alert feedback (false alarm +, confirmed -), clamped
//   notifyThreshold = clamp(tiers.urgent + shiftPerPoint * (care - careNeutral) + learnedShift, minNotify, maxNotify)
//
// A careless history lowers the threshold (a friend is told sooner), a careful one raises it. Only the
// optional notify action moves: voice tiers, overrides (microsleep ...) and the kids rule are unchanged.
import type { RiskConfig } from "./config.ts";
import type { ReportCard } from "./card.ts";

export type DriverProfile = { careIndex: number; scoredTrips: number; learnedShift: number };

export const initialProfile = (cfg: RiskConfig): DriverProfile => ({ careIndex: cfg.adaptive.careNeutral, scoredTrips: 0, learnedShift: 0 });

/** Tolerates the `{}` default of a freshly created driver row. */
export const normalizeProfile = (raw: Partial<DriverProfile> | null | undefined, cfg: RiskConfig): DriverProfile => ({ ...initialProfile(cfg), ...raw });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function notifyThreshold(p: DriverProfile, cfg: RiskConfig): number {
  const A = cfg.adaptive;
  return round2(clamp(cfg.tiers.urgent + A.shiftPerPoint * (p.careIndex - A.careNeutral) + p.learnedShift, A.minNotify, A.maxNotify));
}

export function applyCard(p: DriverProfile, card: ReportCard, cfg: RiskConfig): DriverProfile {
  if (card.provisional) return p;
  const a = cfg.adaptive.careAlpha * card.confidence;
  return { ...p, careIndex: round2((1 - a) * p.careIndex + a * card.score), scoredTrips: p.scoredTrips + 1 };
}

export function applyFeedback(p: DriverProfile, verdict: "false_alarm" | "confirmed", cfg: RiskConfig): DriverProfile {
  const A = cfg.adaptive;
  const step = verdict === "false_alarm" ? A.falseAlarmShift : A.confirmedShift;
  return { ...p, learnedShift: round2(clamp(p.learnedShift + step, -A.learnedClamp, A.learnedClamp)) };
}
