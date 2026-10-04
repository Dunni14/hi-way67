// Trip report card. Pure: stored windows + stored expression observations in, card out.
//
// Formula (formulaVersion 1, every number lives in weights.json -> report):
//   penalty = 0.3 * meanRisk + 0.2 * p90Risk + 30 * tier2Frac + 30 * tier3Frac + 10 * min(microsleeps, 3)
//   score   = clamp(100 - penalty, 0, 100)          (higher is better)
// meanRisk / p90Risk are the 0..100 risk scores of scored windows (the baseline windows are skipped),
// tier2Frac is the share of windows at tier >= 2 and tier3Frac the share at tier 3, so a tier 3 window
// is charged both. Category sub-scores (100 = perfect) are
//   100 * (1 - (0.5 * mean(level) + 0.5 * share(level >= highLevel)))
// for attention (max of distracted, phone), speed, smoothness (erratic), alertness (drowsy) and
// composure (agitated). Confidence is scoredWindows / fullConfidenceWindows, capped at 1.
import type { RiskConfig } from "./config.ts";
import type { GpsCard } from "../gps/route.ts";
import { EXPRESSIONS, type Expression, type Observation } from "./expression.ts";
import type { Evaluation, Tier } from "./types.ts";

export type CardWindow = { ts: string; score: number; tier: Tier; result: Evaluation; raw: { phone_in_hand?: boolean | null; hard_brakes?: number | null; swerves?: number | null } };
export type CardContext = { kidsInCar: boolean; lowExperience: boolean };

export const CATEGORIES = ["attention", "speed", "smoothness", "alertness", "composure"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Letter = "A" | "B" | "C" | "D" | "F";

export type ReportCard = {
  formula_version: number;
  score: number;
  grade: Letter;
  confidence: number;
  provisional: boolean;
  scored_windows: number;
  components: { mean_risk: number; p90_risk: number; tier2_frac: number; tier3_frac: number; microsleeps: number; penalty: number };
  categories: Record<Category, number>;
  expression: { shares: Record<Expression, number>; dominant: Expression | null };
  counts: { hard_brakes: number; swerves: number; phone_windows: number; speeding_windows: number };
  /** Route, alert markers and limit stats; null when the trip had no GPS. Not part of `features`. */
  gps: GpsCard | null;
  /** Fixed-order numeric vector for offline learning; names in `feature_names`. */
  features: number[];
  feature_names: string[];
};

export const FEATURE_NAMES = [
  "mean_risk", "p90_risk", "tier2_frac", "tier3_frac", "microsleeps",
  ...CATEGORIES.map((c) => `cat_${c}`),
  ...EXPRESSIONS.map((e) => `expr_${e}`),
  "kids_in_car", "low_experience",
];

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
};

export function letterOf(score: number, cfg: RiskConfig): Letter {
  const G = cfg.report.grades;
  return score >= G.A ? "A" : score >= G.B ? "B" : score >= G.C ? "C" : score >= G.D ? "D" : "F";
}

export function buildCard(windows: CardWindow[], observations: Observation[], ctx: CardContext, cfg: RiskConfig, gps: GpsCard | null = null): ReportCard {
  const R = cfg.report;
  const scored = windows.slice(cfg.baselineWindows);
  const n = scored.length;
  const risks = scored.map((w) => w.score);
  const meanRisk = mean(risks);
  const p90Risk = percentile(risks, 0.9);
  const tier2Frac = n ? scored.filter((w) => w.tier >= 2).length / n : 0;
  const tier3Frac = n ? scored.filter((w) => w.tier === 3).length / n : 0;
  const microsleeps = scored.filter((w) => w.result.override === "microsleep").length;

  const P = R.penalty;
  const penalty = P.meanRisk * meanRisk + P.p90Risk * p90Risk + P.tier2Frac * tier2Frac + P.tier3Frac * tier3Frac + P.microsleep * Math.min(microsleeps, P.microsleepCap);
  const score = round1(clamp(100 - penalty, 0, 100));

  const sub = (pick: (w: CardWindow) => number) => {
    const xs = scored.map(pick);
    const high = xs.length ? xs.filter((x) => x >= R.highLevel).length / xs.length : 0;
    return round1(100 * (1 - clamp(0.5 * mean(xs) + 0.5 * high)));
  };
  const categories: Record<Category, number> = {
    attention: sub((w) => Math.max(w.result.levels.distracted, w.result.levels.phone)),
    speed: sub((w) => w.result.levels.speeding),
    smoothness: sub((w) => w.result.levels.erratic),
    alertness: sub((w) => w.result.levels.drowsy),
    composure: sub((w) => w.result.levels.agitated),
  };

  const counts = Object.fromEntries(EXPRESSIONS.map((e) => [e, 0])) as Record<Expression, number>;
  for (const o of observations) counts[o.expression] += 1;
  const shares = Object.fromEntries(EXPRESSIONS.map((e) => [e, observations.length ? round3(counts[e] / observations.length) : 0])) as Record<Expression, number>;
  const notable = EXPRESSIONS.filter((e) => e !== "neutral");
  const dominant = observations.length ? notable.reduce((b, e) => (counts[e] > counts[b] ? e : b), notable[0]!) : null;

  const confidence = round3(clamp(n / R.fullConfidenceWindows));
  const features = [
    meanRisk / 100, p90Risk / 100, tier2Frac, tier3Frac, Math.min(microsleeps, P.microsleepCap) / P.microsleepCap,
    ...CATEGORIES.map((c) => categories[c] / 100),
    ...EXPRESSIONS.map((e) => shares[e]),
    Number(ctx.kidsInCar), Number(ctx.lowExperience),
  ].map(round3);

  return {
    formula_version: R.formulaVersion,
    score,
    grade: letterOf(score, cfg),
    confidence,
    provisional: n < R.minWindows,
    scored_windows: n,
    components: { mean_risk: round1(meanRisk), p90_risk: round1(p90Risk), tier2_frac: round3(tier2Frac), tier3_frac: round3(tier3Frac), microsleeps, penalty: round1(penalty) },
    categories,
    expression: { shares, dominant },
    counts: {
      hard_brakes: scored.reduce((s, w) => s + (w.raw.hard_brakes ?? 0), 0),
      swerves: scored.reduce((s, w) => s + (w.raw.swerves ?? 0), 0),
      phone_windows: scored.filter((w) => w.raw.phone_in_hand).length,
      speeding_windows: scored.filter((w) => w.result.levels.speeding > 0).length,
    },
    gps,
    features,
    feature_names: FEATURE_NAMES,
  };
}
