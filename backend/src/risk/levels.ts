// Spec §4: state levels, each 0..1. Null input = no evidence = contributes 0.
import type { RiskConfig } from "./config.ts";
import type { Baseline } from "./smoothing.ts";
import type { Levels, SignalWindow } from "./types.ts";

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const n = (v: number | null | undefined) => (typeof v === "number" ? v : null);

export function computeLevels(w: SignalWindow, base: Baseline, cfg: RiskConfig, opts: { faceless?: boolean } = {}): Levels {
  const L = cfg.levels;
  const speed = n(w.speed_mph);
  const limit = n(w.speed_limit_mph);
  const brakes = n(w.hard_brakes) ?? 0;
  const swerves = n(w.swerves) ?? 0;

  const speeding = speed != null && limit != null ? clamp01(Math.max(speed - limit, 0) / L.speedingFullMph) : 0;
  const erratic = clamp01((brakes + swerves) / L.erraticFull);

  // Face not visible for a while: only speed and motion are trustworthy.
  if (opts.faceless) return { drowsy: 0, agitated: 0, speeding, phone: 0, distracted: 0, erratic };

  const eye = n(w.eye_closure_frac);
  const yawns = n(w.yawns);
  const engagement = n(w.engagement);
  const br = n(w.breathing_rate);
  const hr = n(w.heart_rate);
  const stress = n(w.emotion_stress);
  const gaze = n(w.gaze_off_road_s);

  const d = L.drowsy;
  const drowsy =
    d.eyeClosure * (eye == null ? 0 : Math.min(eye / d.eyeClosureFull, 1)) +
    d.yawns * (yawns == null ? 0 : Math.min(yawns / d.yawnsFull, 1)) +
    d.engagement * (engagement == null ? 0 : 1 - engagement) +
    d.breathing * (br == null || base.breathingRate == null ? 0 : Math.min(Math.max(base.breathingRate - br, 0) / d.breathingFull, 1));

  const a = L.agitated;
  const agitated =
    a.stress * (stress ?? 0) +
    a.heartRate * (hr == null || base.heartRate == null ? 0 : Math.min(Math.max(hr - base.heartRate, 0) / a.heartRateFull, 1));

  return {
    drowsy: clamp01(drowsy),
    agitated: clamp01(agitated),
    speeding,
    phone: w.phone_in_hand ? 1 : 0,
    distracted: gaze == null ? 0 : clamp01(gaze / L.distractedFullS),
    erratic,
  };
}
