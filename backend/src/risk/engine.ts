// RiskEngine: one driver's model + decision state. Presage/phone features in,
// scored window + optional alert Decision out. Pure of I/O apart from the
// injected ports, so it can be tested and later driven by a pull source.
import { adapt, type Feedback } from "./adapt.ts";
import { DecisionTree, type Decision } from "./decision.ts";
import { normalize, toVector, type Baseline, type RawWindow } from "./features.ts";
import { fitWeights } from "./fit.ts";
import { DEFAULT_WEIGHTS, cloneWeights, score, type Context, type Score, type WeightSet } from "./model.ts";
import { InMemoryWeightStore, NoLabelSource, type LabelSource, type WeightStore } from "./ports.ts";

const FEEDBACK_WINDOW_MS = 5 * 60_000;

export type Ingest = {
  ts: number;
  /** Already-normalized 0..1 features by name, or raw readings to normalize here. */
  features?: Partial<Record<string, number>>;
  raw?: RawWindow;
  ctx: Context;
  sharingOn: boolean;
};

export type Result = { x: number[]; score: Score; decision: Decision | null };

export class RiskEngine {
  weights: WeightSet = cloneWeights(DEFAULT_WEIGHTS);
  baseline?: Baseline;
  private tree = new DecisionTree();
  private last: { dominant: Decision["dominant"]; x: number[]; at: number } | null = null;

  constructor(
    readonly driver: string,
    private store: WeightStore = new InMemoryWeightStore(),
    private labels: LabelSource = new NoLabelSource(),
  ) {}

  /** Load this driver's saved weights, if any. */
  async load() {
    const saved = await this.store.load(this.driver);
    if (saved) this.weights = saved;
  }

  /** New trip: clear timers and streaks, keep learned weights. */
  startTrip() {
    this.tree.reset();
    this.last = null;
  }

  ingest(i: Ingest): Result {
    const x = toVector(i.features ?? (i.raw ? normalize(i.raw, this.baseline) : {}));
    const s = score(x, this.weights, i.ctx);
    const decision = this.tree.step(i.ts, s, { kidsInCar: i.ctx.kidsInCar, sharingOn: i.sharingOn });
    if (decision) this.last = { dominant: decision.dominant, x, at: i.ts };
    return { x, score: s, decision };
  }

  /** Driver dismissed ("I'm fine") or confirmed the most recent alert. Returns false if there's nothing recent to learn from. */
  async feedback(fb: Feedback, now = Date.now()): Promise<boolean> {
    if (!this.last || now - this.last.at > FEEDBACK_WINDOW_MS) return false;
    this.weights = adapt(this.weights, this.last.dominant, this.last.x, fb);
    await this.store.save(this.driver, this.weights);
    return true;
  }

  /** Least-squares refit from labeled windows (e.g. landing-page habit answers). */
  async refit(opts?: { ridge?: number; minRows?: number }) {
    const rows = await this.labels.labelsFor(this.driver);
    const { weights, fits } = fitWeights(rows, this.weights, opts);
    this.weights = weights;
    if (Object.keys(fits).length) await this.store.save(this.driver, weights);
    return fits;
  }
}
