// Ports: the seams where future integrations plug in. The risk module only
// depends on these interfaces; defaults below keep everything in memory.
// None of these are called over the network today.
import type { LabeledWindow } from "./fit.ts";
import type { RawWindow } from "./features.ts";
import type { WeightSet } from "./model.ts";

/** Pull source for raw windows (Presage SDK bridge, phone sensors, replayed logs). Future: pull instead of phone push. */
export interface FeatureSource {
  next(): Promise<{ ts: number; raw: RawWindow } | null>;
}

/** Labeled windows for least-squares fitting, e.g. landing-page habit answers joined to stored windows. */
export interface LabelSource {
  labelsFor(driver: string): Promise<LabeledWindow[]>;
}

/** Per-driver weight persistence (Tiger Data later). */
export interface WeightStore {
  load(driver: string): Promise<WeightSet | null>;
  save(driver: string, weights: WeightSet): Promise<void>;
}

export class InMemoryWeightStore implements WeightStore {
  private m = new Map<string, WeightSet>();
  async load(driver: string) {
    return this.m.get(driver) ?? null;
  }
  async save(driver: string, weights: WeightSet) {
    this.m.set(driver, weights);
  }
}

export class NoLabelSource implements LabelSource {
  async labelsFor() {
    return [];
  }
}
