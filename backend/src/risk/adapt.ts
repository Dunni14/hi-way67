// Weight learning (README §2): ridge least-squares fit, and the small
// per-driver gradient step when the driver dismisses or confirms an alert.
import { clamp, ridgeFit, dot } from "./linalg.ts";
import type { Weights } from "./score.ts";
import type { Dominant } from "../ws/protocol.ts";

export const LEARNING_RATE = 0.3;
/** How far one piece of feedback pulls the target score, in r units (0..1). */
export const FEEDBACK_MARGIN = 0.15;
const W_MAX = 1;

/**
 * One SGD step on ½(w·x − y)². A dismissed alert targets a lower score for the
 * window that fired it, a confirmed one a higher score. Only the dominant
 * vector moves: that is the one that raised the alert.
 */
export function nudge(w: Weights, dominant: Dominant, x: number[], verdict: "dismissed" | "confirmed"): Weights {
  const wv = w[dominant];
  const r = dot(wv, x);
  const y = r + (verdict === "dismissed" ? -FEEDBACK_MARGIN : FEEDBACK_MARGIN);
  const err = r - y; // ±FEEDBACK_MARGIN
  const next = wv.map((wi, i) => clamp(wi - LEARNING_RATE * err * (x[i] ?? 0), 0, W_MAX));
  return { ...w, [dominant]: next };
}

/**
 * Fit one weight vector on labeled windows: w = (XᵀX + λI)⁻¹ Xᵀ y, with
 * y in 0..1 (driving-habit survey or reviewed trips). Negative coefficients are
 * clipped to 0: a feature should never lower risk.
 */
export function fitWeights(X: number[][], y: number[], lambda = 1e-2): number[] {
  if (X.length === 0 || X.length !== y.length) throw new Error("X and y must be the same non-zero length");
  return ridgeFit(X, y, lambda).map((v) => clamp(v, 0, W_MAX));
}
