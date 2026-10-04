// The feature vector x (README §2). Every entry is normalized to 0..1.
// Order is the contract: weight vectors are indexed the same way.
export const FEATURE_NAMES = [
  "breathing_dev",
  "heart_rate_dev",
  "engagement", // engagement DEFICIT: 0 = locked on the road, 1 = fully disengaged
  "eye_closure",
  "emotion_stress",
  "hard_brake_count",
  "swerve_count",
  "speed_over_limit",
  "hours_driving",
  "night_time",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, number>;
export const N_FEATURES = FEATURE_NAMES.length;

export const clamp = (v: number, lo = 0, hi = 1) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Named features -> ordered vector. Missing/invalid entries become 0; values are clamped to 0..1. */
export function toVector(f: Partial<Record<string, number>>): number[] {
  return FEATURE_NAMES.map((n) => clamp(f[n] ?? 0));
}

export function toFeatures(x: number[]): Features {
  return Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, x[i] ?? 0])) as Features;
}

// ---- raw Presage / phone readings -> normalized features ---------------------

/** What one 10 s window looks like before normalization. */
export type RawWindow = {
  breathingRate?: number; // breaths/min (Presage)
  heartRate?: number; // bpm (Presage)
  engagement?: number; // 0..1, 1 = engaged (Presage)
  eyeClosure?: number; // 0..1 fraction of the window with eyes closed
  stress?: number; // 0..1 anger/stress expression score
  hardBrakes?: number; // count in window (IMU)
  swerves?: number; // count in window (IMU/gyro)
  speedMph?: number; // GPS
  speedLimitMph?: number; // GPS/maps
  hoursDriving?: number; // since trip start (or last long break)
  hourOfDay?: number; // 0..23 local
};

/** Per-trip baseline captured in the first minutes of the drive. */
export type Baseline = { breathingRate: number; heartRate: number };

export const DEFAULT_BASELINE: Baseline = { breathingRate: 15, heartRate: 70 };

// Saturation points: the raw value at which a feature reads 1.0.
const BREATH_DEV_FULL = 0.4; // 40 % away from baseline
const HR_DEV_FULL = 0.3; // 30 % away from baseline
const EVENTS_FULL = 3; // 3 brakes / swerves in 10 s is maxed out
const OVER_LIMIT_FULL = 20; // mph over the limit
const HOURS_FULL = 6;

export function normalize(raw: RawWindow, base: Baseline = DEFAULT_BASELINE): Features {
  const dev = (v: number | undefined, b: number, full: number) => (v == null ? 0 : clamp(Math.abs(v - b) / b / full));
  const hour = raw.hourOfDay;
  return {
    breathing_dev: dev(raw.breathingRate, base.breathingRate, BREATH_DEV_FULL),
    heart_rate_dev: dev(raw.heartRate, base.heartRate, HR_DEV_FULL),
    engagement: raw.engagement == null ? 0 : clamp(1 - raw.engagement),
    eye_closure: clamp(raw.eyeClosure ?? 0),
    emotion_stress: clamp(raw.stress ?? 0),
    hard_brake_count: clamp((raw.hardBrakes ?? 0) / EVENTS_FULL),
    swerve_count: clamp((raw.swerves ?? 0) / EVENTS_FULL),
    speed_over_limit:
      raw.speedMph == null || raw.speedLimitMph == null ? 0 : clamp((raw.speedMph - raw.speedLimitMph) / OVER_LIMIT_FULL),
    hours_driving: clamp((raw.hoursDriving ?? 0) / HOURS_FULL),
    night_time: hour != null && (hour >= 22 || hour < 5) ? 1 : 0,
  };
}
