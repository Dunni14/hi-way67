// LinUCB, one model per (driver, action). Pure functions over (A, b, x, r): no I/O.
// A is a flattened d×d row-major matrix. Linear systems are solved by Gaussian
// elimination with partial pivoting; A is never inverted explicitly.
export type Model = { A: number[]; b: number[]; updates: number };

export const identity = (d: number): number[] => Array.from({ length: d * d }, (_, i) => (i % (d + 1) === 0 ? 1 : 0));

/** Fresh model: A = I, b = 0, except b[0] = `bias` for an action that is some tier's default. */
export function initModel(d: number, bias = 0): Model {
  const b = new Array<number>(d).fill(0);
  b[0] = bias;
  return { A: identity(d), b, updates: 0 };
}

/** Solve A y = v. A must be non-singular (it is symmetric positive definite by construction). */
export function solve(A: number[], v: number[]): number[] {
  const d = v.length;
  const m = A.slice();
  const y = v.slice();
  for (let c = 0; c < d; c++) {
    let p = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(m[r * d + c]!) > Math.abs(m[p * d + c]!)) p = r;
    if (p !== c) {
      for (let k = 0; k < d; k++) [m[c * d + k], m[p * d + k]] = [m[p * d + k]!, m[c * d + k]!];
      [y[c], y[p]] = [y[p]!, y[c]!];
    }
    const piv = m[c * d + c]!;
    for (let r = c + 1; r < d; r++) {
      const f = m[r * d + c]! / piv;
      if (f === 0) continue;
      for (let k = c; k < d; k++) m[r * d + k]! -= f * m[c * d + k]!;
      y[r]! -= f * y[c]!;
    }
  }
  for (let r = d - 1; r >= 0; r--) {
    let s = y[r]!;
    for (let k = r + 1; k < d; k++) s -= m[r * d + k]! * y[k]!;
    y[r] = s / m[r * d + r]!;
  }
  return y;
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);

/** p = thetaᵀx + alpha * sqrt(xᵀ A⁻¹ x), with theta = A⁻¹ b. */
export function ucb(model: Model, x: number[], alpha: number): number {
  const theta = solve(model.A, model.b);
  const Ainvx = solve(model.A, x);
  return dot(theta, x) + alpha * Math.sqrt(Math.max(dot(x, Ainvx), 0));
}

const TIE_EPS = 1e-9;

/** Highest p wins; ties go to `defaultAction`, then to the first listed. */
export function choose(
  models: Record<string, Model>,
  allowed: string[],
  x: number[],
  alpha: number,
  defaultAction: string,
): { action: string; scores: Record<string, number> } {
  const scores: Record<string, number> = {};
  for (const a of allowed) scores[a] = ucb(models[a]!, x, alpha);
  const best = Math.max(...allowed.map((a) => scores[a]!));
  const tied = allowed.filter((a) => best - scores[a]! <= TIE_EPS);
  return { action: tied.includes(defaultAction) ? defaultAction : tied[0]!, scores };
}

/** A += x xᵀ, b += r x. */
export function update(model: Model, x: number[], r: number): Model {
  const d = x.length;
  const A = model.A.slice();
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) A[i * d + j]! += x[i]! * x[j]!;
  return { A, b: model.b.map((v, i) => v + r * x[i]!), updates: model.updates + 1 };
}
