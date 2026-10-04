// Minimal dense linear algebra for the risk model. Vectors are number[],
// matrices are number[][] (row-major). Sizes here are ~11 x a few hundred.
export type Vec = number[];
export type Mat = number[][];

export const dot = (a: Vec, b: Vec) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

export const transpose = (m: Mat): Mat => (m[0] ?? []).map((_, j) => m.map((row) => row[j]!));

export const matMul = (a: Mat, b: Mat): Mat => {
  const bt = transpose(b);
  return a.map((row) => bt.map((col) => dot(row, col)));
};

export const matVec = (m: Mat, v: Vec): Vec => m.map((row) => dot(row, v));

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Solve A z = b by Gaussian elimination with partial pivoting. Throws if singular. */
export function solve(A: Mat, b: Vec): Vec {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) throw new Error("singular matrix");
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const z: Vec = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * z[k]!;
    z[r] = s / M[r]![r]!;
  }
  return z;
}

/**
 * Ridge least squares: w = (XᵀX + λI)⁻¹ Xᵀ y. With λ = 0 this is the plain
 * normal equation from the README; λ > 0 keeps it solvable when feature
 * windows are collinear or there are fewer rows than features.
 */
export function ridgeFit(X: Mat, y: Vec, lambda = 1e-2): Vec {
  const Xt = transpose(X);
  const A = matMul(Xt, X);
  for (let i = 0; i < A.length; i++) A[i]![i]! += lambda;
  return solve(A, matVec(Xt, y));
}
