// Expression observations: one categorical label per 10 s window, derived from raw signals only
// (no baseline, no score), so it is stable to store and to re-derive. Pure.
import type { RiskConfig } from "./config.ts";
import type { SignalWindow } from "./types.ts";

export const EXPRESSIONS = ["calm", "neutral", "stressed", "drowsy", "distracted", "no_face"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export type Observation = {
  ts: string;
  expression: Expression;
  /** 0..1, strength of the cue behind the label. */
  intensity: number;
  face_visible: boolean | null;
  stress: number | null;
  engagement: number | null;
  eye_closure_frac: number | null;
  yawns: number | null;
  gaze_off_road_s: number | null;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Priority: no_face > drowsy > stressed > distracted > calm > neutral. */
export function observe(w: SignalWindow, cfg: RiskConfig): Observation {
  const E = cfg.expression;
  const eye = num(w.eye_closure_frac);
  const yawns = num(w.yawns);
  const closure = num(w.longest_eye_closure_s);
  const stress = num(w.emotion_stress);
  const engagement = num(w.engagement);
  const gaze = num(w.gaze_off_road_s);
  const base = {
    ts: w.ts,
    face_visible: w.face_visible ?? null,
    stress,
    engagement,
    eye_closure_frac: eye,
    yawns,
    gaze_off_road_s: gaze,
  };

  let expression: Expression = "neutral";
  let intensity = 0;
  if (w.face_visible === false) {
    expression = "no_face";
  } else if ((eye ?? 0) >= E.drowsyEye || (yawns ?? 0) >= E.drowsyYawns || (closure ?? 0) >= E.drowsyClosureS) {
    expression = "drowsy";
    intensity = clamp01(Math.max((eye ?? 0) / 0.3, (yawns ?? 0) / 3, (closure ?? 0) / 1.5));
  } else if ((stress ?? 0) >= E.stress) {
    expression = "stressed";
    intensity = clamp01(stress ?? 0);
  } else if ((gaze ?? 0) >= E.gazeS || w.phone_in_hand) {
    expression = "distracted";
    intensity = w.phone_in_hand ? 1 : clamp01((gaze ?? 0) / 4);
  } else if ((engagement ?? 0) >= E.calmEngagement && (stress ?? 0) < E.calmStress) {
    expression = "calm";
    intensity = clamp01((engagement ?? 0) * (1 - (stress ?? 0)));
  }
  return { ...base, expression, intensity };
}
