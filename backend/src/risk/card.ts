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
import { EXPRESSIONS, type Expression, type Observation } from "./expression.ts";
import type { Action, Evaluation, Override, SignalWindow, Tier } from "./types.ts";

export type CardWindow = { ts: string; score: number; tier: Tier; result: Evaluation; raw: SignalWindow };
export type CardContext = { kidsInCar: boolean; lowExperience: boolean };
/** Facts from outside the windows: the trip's events, the driver's baseline and the feedback they gave. */
export type CardExtra = {
  events?: { actions: Action[]; override: Override | null }[];
  baselineHr?: number | null;
  sharingMode?: string | null;
  feedback?: { confirmed: number; false_alarm: number };
};

const WINDOW_S = 10;
const BUCKET_MS = 30_000;

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
  /** Fixed-order numeric vector for offline learning; names in `feature_names`. */
  features: number[];
  feature_names: string[];
  metrics: Metrics;
  /** 30 s buckets (peak score, highest tier) so a report survives the raw-window retention. */
  series: { ts: string; score: number; tier: Tier }[];
  sharing_mode: string | null;
  /** Set by the service when the trip ends: the driver's profile around this trip. */
  profile: { care_before: number; care_after: number; notify_threshold: number } | null;
};

export type Metrics = {
  duration_s: number;
  night_trip: boolean;
  distance_mi: number;
  avg_speed_mph: number;
  max_speed_mph: number;
  over_limit_s: number;
  max_over_limit_mph: number;
  max_risk: number;
  max_tier: Tier;
  tier_seconds: [number, number, number, number];
  yawns: number;
  longest_eye_closure_s: number;
  gaze_off_road_s: number;
  phone_s: number;
  degraded_s: number;
  hr_above_baseline_mean: number | null;
  hr_above_baseline_peak: number | null;
  interventions: Record<"voice_nudge" | "voice_warning" | "voice_urgent" | "notify_contacts" | "ask_permission_to_notify", number>;
  overrides: Partial<Record<Override, number>>;
  feedback: { confirmed: number; false_alarm: number };
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

function buildMetrics(all: CardWindow[], scored: CardWindow[], extra: CardExtra): Metrics {
  const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const speeds = all.map((w) => w.raw.speed_mph).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const over = all.map((w) => (w.raw.speed_mph != null && w.raw.speed_limit_mph != null ? Math.max(0, w.raw.speed_mph - w.raw.speed_limit_mph) : 0));
  const tierSeconds: [number, number, number, number] = [0, 0, 0, 0];
  for (const w of scored) tierSeconds[w.tier] += WINDOW_S;
  const base = extra.baselineHr;
  const hrAbove = base == null ? [] : scored.map((w) => w.raw.heart_rate).filter((v): v is number => typeof v === "number").map((hr) => Math.max(0, hr - base));
  const interventions = { voice_nudge: 0, voice_warning: 0, voice_urgent: 0, notify_contacts: 0, ask_permission_to_notify: 0 };
  const overrides: Partial<Record<Override, number>> = {};
  for (const e of extra.events ?? []) {
    for (const a of e.actions) if (a in interventions) interventions[a as keyof typeof interventions] += 1;
    if (e.override) overrides[e.override] = (overrides[e.override] ?? 0) + 1;
  }
  const startHour = all[0] ? new Date(all[0].ts).getHours() : 12;
  return {
    duration_s: all.length * WINDOW_S,
    night_trip: startHour >= 22 || startHour < 5,
    distance_mi: round3(all.reduce((s, w) => s + (num(w.raw.speed_mph) * WINDOW_S) / 3600, 0)),
    avg_speed_mph: round1(mean(speeds)),
    max_speed_mph: round1(speeds.length ? Math.max(...speeds) : 0),
    over_limit_s: over.filter((o) => o > 0).length * WINDOW_S,
    max_over_limit_mph: round1(over.length ? Math.max(...over) : 0),
    max_risk: round1(scored.length ? Math.max(...scored.map((w) => w.score)) : 0),
    max_tier: scored.reduce<Tier>((m, w) => (w.tier > m ? w.tier : m), 0),
    tier_seconds: tierSeconds,
    yawns: scored.reduce((s, w) => s + num(w.raw.yawns), 0),
    longest_eye_closure_s: round1(scored.reduce((m, w) => Math.max(m, num(w.raw.longest_eye_closure_s)), 0)),
    gaze_off_road_s: round1(scored.reduce((s, w) => s + num(w.raw.gaze_off_road_s), 0)),
    phone_s: scored.filter((w) => w.raw.phone_in_hand).length * WINDOW_S,
    degraded_s: all.filter((w) => w.result.degraded || w.raw.face_visible === false).length * WINDOW_S,
    hr_above_baseline_mean: hrAbove.length ? round1(mean(hrAbove)) : null,
    hr_above_baseline_peak: hrAbove.length ? round1(Math.max(...hrAbove)) : null,
    interventions,
    overrides,
    feedback: extra.feedback ?? { confirmed: 0, false_alarm: 0 },
  };
}

function buildSeries(all: CardWindow[]): ReportCard["series"] {
  const buckets = new Map<number, { score: number; tier: Tier }>();
  for (const w of all) {
    const key = Math.floor(Date.parse(w.ts) / BUCKET_MS) * BUCKET_MS;
    const b = buckets.get(key) ?? { score: 0, tier: 0 as Tier };
    buckets.set(key, { score: Math.max(b.score, w.score), tier: Math.max(b.tier, w.tier) as Tier });
  }
  return [...buckets].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ ts: new Date(k).toISOString(), score: round1(v.score), tier: v.tier }));
}

export function buildCard(windows: CardWindow[], observations: Observation[], ctx: CardContext, cfg: RiskConfig, extra: CardExtra = {}): ReportCard {
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
    features,
    feature_names: FEATURE_NAMES,
    metrics: buildMetrics(windows, scored, extra),
    series: buildSeries(windows),
    sharing_mode: extra.sharingMode ?? null,
    profile: null,
  };
}
