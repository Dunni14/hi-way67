// Minimal dense linear algebra for the risk model. Matrices are row-major
// number[][]; vectors are number[]. Sizes here are tiny (10 features), so
// clarity beats speed.
export type Vec = number[];
export type Mat = number[][];

export const dot = (a: Vec, b: Vec): number => {
  if (a.length !== b.length) throw new Error(`dot: length ${a.length} vs ${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

export const transpose = (A: Mat): Mat => (A[0] ?? []).map((_, j) => A.map((row) => row[j]!));

export const matMul = (A: Mat, B: Mat): Mat => {
  const Bt = transpose(B);
  return A.map((row) => Bt.map((col) => dot(row, col)));
};

export const matVec = (A: Mat, v: Vec): Vec => A.map((row) => dot(row, v));

/** Solve A·x = b by Gaussian elimination with partial pivoting. Returns null if A is singular. */
export function solve(A: Mat, b: Vec): Vec | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= M[i]![j]! * x[j]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}
