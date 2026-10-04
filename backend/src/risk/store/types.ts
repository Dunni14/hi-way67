// Persistence boundary for the risk engine. Timestamps are ISO strings at this
// edge; the Postgres implementation converts to/from TIMESTAMPTZ.
import type { ReportCard } from "../card.ts";
import type { Observation } from "../expression.ts";
import type { DriverProfile } from "../profile.ts";
import type { Baseline } from "../smoothing.ts";
import type { Action, Evaluation, Override, SharingMode, EngineWindow, Tier, WeightMults } from "../types.ts";

export type DriverRow = { id: string; sharingMode: SharingMode; shareLocation: boolean; weightOverrides: Partial<WeightMults>; profile: Partial<DriverProfile> };

export type TripRow = {
  id: string;
  driverId: string;
  startedAt: string;
  endedAt: string | null;
  kidsInCar: boolean;
  lowExperience: boolean;
  sleepHours: number | null;
  baseline: Baseline | null;
};

export type WindowRow = { tripId: string; ts: string; raw: EngineWindow; result: Evaluation; score: number; tier: Tier };

export type EventRow = { tripId: string; ts: string; tier: Tier; actions: Action[]; override: Override | null };

export type CardRow = { tripId: string; driverId: string; createdAt: string; card: ReportCard };

/** One logged decision for later reinforcement learning: 8-number context, action taken, reward once known. */
export type DecisionRow = { tripId: string; ts: string; tier: Tier; dominant: string; action: Action; context: number[]; scores: Record<string, unknown> };

/** One good GPS fix of an active trip, with the window's limit and the per-fix motion used by the 10 s aggregate. */
export type GpsSampleRow = {
  time: string;
  lat: number;
  lon: number;
  speedMps: number | null;
  headingDeg: number | null;
  hAccuracyM: number | null;
  accelMps2: number | null;
  headingRateDps: number | null;
  limitMps: number | null;
  limitSource: string | null;
};

export interface RiskStore {
  /** Create the driver if missing; returns the stored row. Omitted settings keep their stored value. */
  upsertDriver(id: string, sharingMode?: SharingMode, shareLocation?: boolean): Promise<DriverRow>;
  getDriver(id: string): Promise<DriverRow | null>;
  setWeightOverrides(id: string, overrides: Partial<WeightMults>): Promise<void>;
  setProfile(id: string, profile: DriverProfile): Promise<void>;

  createTrip(t: Omit<TripRow, "endedAt" | "baseline">): Promise<void>;
  getTrip(id: string): Promise<TripRow | null>;
  endTrip(id: string, endedAt: string): Promise<void>;
  setBaseline(id: string, baseline: Baseline): Promise<void>;
  listTrips(driverId: string): Promise<TripRow[]>;

  /** Returns false if a window with this (trip, ts) already exists. */
  addWindow(w: WindowRow): Promise<boolean>;
  getWindows(tripId: string): Promise<WindowRow[]>; // ascending by ts
  getWindow(tripId: string, ts: string): Promise<WindowRow | null>;

  addEvent(e: EventRow): Promise<void>;
  getEvents(tripId: string): Promise<EventRow[]>;

  addObservation(o: Observation & { tripId: string }): Promise<void>;
  getObservations(tripId: string): Promise<Observation[]>; // ascending by ts

  addGpsSamples(tripId: string, samples: GpsSampleRow[]): Promise<void>;
  getGpsSamples(tripId: string): Promise<GpsSampleRow[]>; // ascending by time

  saveCard(c: CardRow): Promise<void>;
  getCard(tripId: string): Promise<CardRow | null>;

  addDecision(d: DecisionRow): Promise<void>;
  /** Sets the reward on the decision logged at (trip, ts); returns its action, or null if none. */
  rewardDecision(tripId: string, ts: string, reward: number): Promise<Action | null>;
}
