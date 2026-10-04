// Risk score (README §2): r = w · x, m = 1 + c · k, R = clamp(100 · r · m, 0, 100).
// Two weight vectors over the same x give the drowsy and reckless sub-scores;
// the combined R is the larger of the two so the tree knows which one fired.
import { clamp, dot } from "./linalg.ts";
import { FEATURES, PRESAGE_FEATURES, toVector, type FeatureMap, type FeatureName } from "./features.ts";
import type { Dominant } from "../ws/protocol.ts";

export type Weights = { drowsy: number[]; reckless: number[] };

const vec = (m: Partial<Record<FeatureName, number>>) => FEATURES.map((k) => m[k] ?? 0);

/** Hand-set so the demo works before any fitting. Rows sum above 1 on purpose: not every feature maxes out. */
export const DEFAULT_WEIGHTS: Weights = {
  drowsy: vec({
    breathing_drop: 0.15,
    hr_drop: 0.15,
    engagement_loss: 0.25,
    eye_closure: 0.45,
    swerve_count: 0.05,
    hours_driving: 0.1,
    night_time: 0.1,
  }),
  reckless: vec({
    hr_spike: 0.25,
    emotion_stress: 0.25,
    engagement_loss: 0.05,
    hard_brake_count: 0.3,
    swerve_count: 0.3,
    speed_over_limit: 0.35,
    night_time: 0.05,
  }),
};

/** Context vector c = [kids_in_car, low_experience] and its gains k. */
export type Context = { kidsInCar: boolean; lowExperience: boolean };
export const CONTEXT_GAIN = [0.25, 0.15] as const;

export const multiplier = (c: Context) => 1 + dot([c.kidsInCar ? 1 : 0, c.lowExperience ? 1 : 0], [...CONTEXT_GAIN]);

export type Score = {
  R: number; // 0..100 combined
  drowsy: number; // 0..100 sub-score
  reckless: number; // 0..100 sub-score
  dominant: Dominant;
  m: number;
};

/**
 * `available` lists features that could actually be measured this window. When
 * Presage loses the face, the Presage terms are missing rather than zero, so
 * the remaining (phone-sensor) weight is rescaled up to compensate, capped at
 * 2x so noisy phone-only data cannot swing the score wildly.
 */
export function score(f: FeatureMap, w: Weights, ctx: Context, available?: Set<FeatureName>): Score {
  const x = toVector(f);
  const m = multiplier(ctx);
  const sub = (wv: number[]) => {
    let r = dot(wv, x);
    if (available) {
      const total = wv.reduce((s, v) => s + v, 0);
      const lost = FEATURES.reduce(
        (s, k, i) => (PRESAGE_FEATURES.includes(k) && !available.has(k) ? s + wv[i]! : s),
        0,
      );
      const have = total - lost;
      if (lost > 0 && have > 0) r *= Math.min(2, total / have);
    }
    return clamp(100 * r * m, 0, 100);
  };
  const drowsy = sub(w.drowsy);
  const reckless = sub(w.reckless);
  return { R: Math.max(drowsy, reckless), drowsy, reckless, dominant: drowsy >= reckless ? "drowsy" : "reckless", m };
}
