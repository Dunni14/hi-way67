// Per-driver adaptation ("behavioral reinforcement"): one small gradient step on
// the sub-score that fired, using the window that triggered the alert.
//
// Loss = ½(r − t)² with r = w·x, so ∂L/∂w = (r − t)·x. We don't have a true
// label, only a nudge: dismissed -> target a bit lower, confirmed -> a bit higher.
import { dot } from "./linalg.ts";
import { cloneWeights, type Dominant, type WeightSet } from "./model.ts";

export type Feedback = "dismissed" | "confirmed";

export const ADAPT = {
  lr: 0.5,
  /** How far (in base-risk units, 0..1) we pull the target away from the current r. */
  dismissShift: 0.15,
  confirmShift: 0.08,
  maxWeight: 1,
};

export function adapt(weights: WeightSet, dominant: Dominant, x: number[], fb: Feedback, p = ADAPT): WeightSet {
  const next = cloneWeights(weights);
  const w = next[dominant];
  const r = dot(w, x);
  const target = fb === "dismissed" ? Math.max(0, r - p.dismissShift) : r + p.confirmShift;
  const grad = r - target;
  for (let i = 0; i < w.length; i++) {
    // Only features that were actually present move their weight; keep weights in [0, maxWeight].
    w[i] = Math.min(p.maxWeight, Math.max(0, w[i]! - p.lr * grad * x[i]!));
  }
  return next;
}
