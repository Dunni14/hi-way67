// Fitting the weights by least squares: w = (XᵀX)⁻¹Xᵀy.
// We add a tiny ridge term (λ·I) to XᵀX so a handful of labeled windows, or
// collinear features, can't make it singular. Set ridge = 0 for the textbook form.
import { N_FEATURES } from "./features.ts";
import { dot, matMul, matVec, solve, transpose } from "./linalg.ts";
import type { Dominant, WeightSet } from "./model.ts";

export type LabeledWindow = {
  x: number[];
  /** Labeled risk 0..1 (not 0..100), e.g. derived from landing-page habit answers. */
  y: number;
  /** Which sub-score the label speaks to. */
  target: Dominant;
};

export type FitResult = { w: number[]; rmse: number; n: number };

export function leastSquares(X: number[][], y: number[], ridge = 1e-3): number[] | null {
  const Xt = transpose(X);
  const A = matMul(Xt, X);
  for (let i = 0; i < A.length; i++) A[i]![i]! += ridge;
  return solve(A, matVec(Xt, y));
}

export function fitOne(rows: LabeledWindow[], opts: { ridge?: number; nonNegative?: boolean } = {}): FitResult | null {
  if (rows.length < 2) return null;
  const w = leastSquares(rows.map((r) => r.x), rows.map((r) => r.y), opts.ridge);
  if (!w) return null;
  // Negative weights read as "more of this lowers risk", which we don't want to explain on stage.
  const fitted = (opts.nonNegative ?? true) ? w.map((v) => Math.max(0, v)) : w;
  const sse = rows.reduce((s, r) => s + (dot(fitted, r.x) - r.y) ** 2, 0);
  return { w: fitted, rmse: Math.sqrt(sse / rows.length), n: rows.length };
}

/**
 * Fit both weight vectors. A sub-score with too few labels (< `minRows`) keeps
 * its current weights, so partial label sets are safe.
 */
export function fitWeights(
  rows: LabeledWindow[],
  current: WeightSet,
  opts: { ridge?: number; minRows?: number } = {},
): { weights: WeightSet; fits: Partial<Record<Dominant, FitResult>> } {
  const minRows = opts.minRows ?? N_FEATURES;
  const weights: WeightSet = { drowsy: [...current.drowsy], reckless: [...current.reckless] };
  const fits: Partial<Record<Dominant, FitResult>> = {};
  for (const target of ["drowsy", "reckless"] as const) {
    const mine = rows.filter((r) => r.target === target);
    if (mine.length < minRows) continue;
    const fit = fitOne(mine, opts);
    if (!fit) continue;
    weights[target] = fit.w;
    fits[target] = fit;
  }
  return { weights, fits };
}
