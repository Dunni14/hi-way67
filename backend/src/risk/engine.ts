// Per-driver risk engine: 1 Hz samples in, 10 s scored windows and tree
// decisions out. Weights persist across trips so feedback keeps paying off.
import { toVector, type FeatureMap } from "./features.ts";
import { SignalProcessor, type Sample } from "./signals.ts";
import { DEFAULT_WEIGHTS, score, type Context, type Score, type Weights } from "./score.ts";
import { DecisionTree, type Decision } from "./tree.ts";
import { nudge } from "./adapt.ts";
import type { SharingMode } from "../ws/protocol.ts";

export const WINDOW_MS = 10_000;

export type ScoredWindow = Score & {
  ts: number;
  features: FeatureMap;
  faceVisible: boolean;
  calibrating: boolean;
};

export type EngineOutput = { window: ScoredWindow; decision: Decision | null };

export class RiskEngine {
  weights: Weights = structuredClone(DEFAULT_WEIGHTS);
  context: Context = { kidsInCar: false, lowExperience: false };
  sharing: SharingMode = "high_only";

  private signals = new SignalProcessor();
  private tree = new DecisionTree();
  private tripStart: number | null = null;
  private windowEnd: number | null = null;
  private last: { x: number[]; dominant: Decision["dominant"] } | null = null;

  startTrip(now: number) {
    this.signals = new SignalProcessor();
    this.tree.reset();
    this.tripStart = now;
    this.windowEnd = now + WINDOW_MS;
    this.last = null;
  }

  /** Feed one second of signals. Returns a scored window every 10 s. */
  push(s: Sample): EngineOutput | null {
    if (this.tripStart === null) this.startTrip(s.ts);
    this.signals.push(s);
    if (s.ts < this.windowEnd!) return null;
    this.windowEnd = s.ts + WINDOW_MS;

    const hours = (s.ts - this.tripStart!) / 3_600_000;
    const { features, available, faceVisible, calibrating } = this.signals.takeWindow(s.ts, hours);
    const sc = score(features, this.weights, this.context, available);
    const x = toVector(features);
    this.last = { x, dominant: sc.dominant };

    const decision = this.tree.step({
      ts: s.ts,
      R: sc.R,
      drowsy: sc.drowsy,
      reckless: sc.reckless,
      kidsInCar: this.context.kidsInCar,
      sharing: this.sharing,
    });
    return { window: { ...sc, ts: s.ts, features, faceVisible, calibrating }, decision };
  }

  /**
   * Driver feedback on the most recent alert. "dismissed" ("I'm fine") backs
   * the tree off and lowers the weights that fired; "confirmed" (driver took
   * the rest-stop offer) raises them.
   */
  feedback(verdict: "dismissed" | "confirmed", now: number) {
    if (!this.last) return;
    if (verdict === "dismissed") this.tree.dismiss(now);
    this.weights = nudge(this.weights, this.last.dominant, this.last.x, verdict);
  }
}

export const riskEngine = new RiskEngine();
