// Rolling mean over the last N windows, and the trip baseline. Pure.
import type { EngineWindow } from "./types.ts";

const NUMERIC = [
  "heart_rate",
  "breathing_rate",
  "engagement",
  "eye_closure_frac",
  "yawns",
  "emotion_stress",
  "gaze_off_road_s",
  "hard_brakes",
  "swerves",
  "speed_mph",
  "speed_limit_mph",
  "gps_speeding",
  "gps_erratic",
] as const;

const mean = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/**
 * Smooth the numeric signals over `recent` (nulls ignored; all-null stays null).
 * Booleans and `longest_eye_closure_s` are taken from the newest window as-is:
 * averaging would dilute a microsleep and a phone in hand is an instant fact.
 */
export function smooth(recent: EngineWindow[]): EngineWindow {
  const last = recent[recent.length - 1]!;
  const out: EngineWindow = { ...last };
  for (const k of NUMERIC) out[k] = mean(recent.map((w) => w[k]));
  return out;
}

export type Baseline = { heartRate: number | null; breathingRate: number | null };

export const baselineOf = (windows: EngineWindow[]): Baseline => ({
  heartRate: mean(windows.map((w) => w.heart_rate)),
  breathingRate: mean(windows.map((w) => w.breathing_rate)),
});
