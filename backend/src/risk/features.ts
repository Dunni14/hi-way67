// Feature vector x (README §2). Every feature is normalized to 0..1.
//
// The README lists breathing_dev, heart_rate_dev and engagement as single
// features, but drowsy and reckless need *opposite* directions of the same
// vital (HR falling = drowsy, HR spiking = reckless). A linear w · x cannot
// tell those apart from a magnitude, so deviations are split by direction and
// engagement is expressed as loss (1 - engagement). Same 0..1 range, 11 slots.
import { clamp } from "./linalg.ts";

export const FEATURES = [
  "breathing_drop", // breathing rate below baseline
  "hr_drop", // heart rate below baseline
  "hr_spike", // heart rate above baseline
  "engagement_loss", // 1 - engagement
  "eye_closure",
  "emotion_stress", // anger / stress expression
  "hard_brake_count",
  "swerve_count",
  "speed_over_limit",
  "hours_driving",
  "night_time",
] as const;
export type FeatureName = (typeof FEATURES)[number];
export type FeatureMap = Record<FeatureName, number>;

/** Features that come from the Presage face pipeline (missing when the face is lost). */
export const PRESAGE_FEATURES: readonly FeatureName[] = [
  "breathing_drop",
  "hr_drop",
  "hr_spike",
  "engagement_loss",
  "eye_closure",
  "emotion_stress",
];

export const emptyFeatures = (): FeatureMap => Object.fromEntries(FEATURES.map((k) => [k, 0])) as FeatureMap;

export const toVector = (f: FeatureMap): number[] => FEATURES.map((k) => clamp(f[k], 0, 1));

export const fromVector = (v: number[]): FeatureMap =>
  Object.fromEntries(FEATURES.map((k, i) => [k, v[i] ?? 0])) as FeatureMap;

/** Normalizers: raw counts, hours and mph → 0..1. */
export const norm = {
  hardBrakes: (n: number) => clamp(n / 3, 0, 1),
  swerves: (n: number) => clamp(n / 3, 0, 1),
  speedOver: (mph: number, limit: number) => clamp((mph - limit) / 20, 0, 1),
  hours: (h: number) => clamp(h / 4, 0, 1),
  night: (d: Date) => (d.getHours() >= 22 || d.getHours() < 5 ? 1 : 0),
  /** Relative deviation: |value - base| / (base * fullScale), clamped. */
  rel: (delta: number, base: number, fullScale: number) => clamp(delta / (Math.abs(base) * fullScale || 1), 0, 1),
};
