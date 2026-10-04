// Risk scoring (README §2): r = w·x, m = 1 + c·k, R = clamp(100·r·m, 0, 100).
// Two weight vectors over the same x give two sub-scores (drowsy, reckless);
// the larger one is the combined R and names the dominant state.
import { FEATURE_NAMES, N_FEATURES, clamp } from "./features.ts";
import { dot } from "./linalg.ts";

export type Dominant = "drowsy" | "reckless";
export type WeightSet = Record<Dominant, number[]>;

/** Trip-start toggles. They scale existing risk, they never add any. */
export type Context = { kidsInCar: boolean; lowExperience: boolean };
/** k: how much each context toggle raises the stakes (m = 1 + c·k). */
export const CONTEXT_K: Record<keyof Context, number> = { kidsInCar: 0.25, lowExperience: 0.15 };

const w = (o: Partial<Record<(typeof FEATURE_NAMES)[number], number>>) => FEATURE_NAMES.map((n) => o[n] ?? 0);

// Hand-set starting weights so the demo works before any fitting. Rows sum to a
// bit over 1 on purpose: one maxed signal alone shouldn't reach 100, but a
// couple of strong signals together should cross the 70 / 85 tiers.
export const DEFAULT_WEIGHTS: WeightSet = {
  drowsy: w({ eye_closure: 0.4, engagement: 0.25, breathing_dev: 0.15, heart_rate_dev: 0.1, swerve_count: 0.1, hours_driving: 0.15, night_time: 0.1 }),
  reckless: w({ speed_over_limit: 0.3, hard_brake_count: 0.25, emotion_stress: 0.25, swerve_count: 0.2, heart_rate_dev: 0.15, breathing_dev: 0.05 }),
};

export type Score = {
  /** Context multiplier m. */
  m: number;
  /** Base risk r per sub-score (unscaled, can exceed 1). */
  base: Record<Dominant, number>;
  /** Sub-scores 0..100 after the multiplier. */
  drowsy: number;
  reckless: number;
  /** max(drowsy, reckless), 0..100. */
  R: number;
  dominant: Dominant;
};

export function contextMultiplier(ctx: Context): number {
  return 1 + (ctx.kidsInCar ? CONTEXT_K.kidsInCar : 0) + (ctx.lowExperience ? CONTEXT_K.lowExperience : 0);
}

export function score(x: number[], weights: WeightSet, ctx: Context): Score {
  if (x.length !== N_FEATURES) throw new Error(`expected ${N_FEATURES} features, got ${x.length}`);
  const m = contextMultiplier(ctx);
  const base = { drowsy: dot(weights.drowsy, x), reckless: dot(weights.reckless, x) };
  const drowsy = clamp(100 * base.drowsy * m, 0, 100);
  const reckless = clamp(100 * base.reckless * m, 0, 100);
  return { m, base, drowsy, reckless, R: Math.max(drowsy, reckless), dominant: drowsy >= reckless ? "drowsy" : "reckless" };
}

export const cloneWeights = (ws: WeightSet): WeightSet => ({ drowsy: [...ws.drowsy], reckless: [...ws.reckless] });
