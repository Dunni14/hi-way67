// Persistence boundary for the risk engine. Timestamps are ISO strings at this
// edge; the Postgres implementation converts to/from TIMESTAMPTZ.
import type { Baseline } from "../smoothing.ts";
import type { Action, Evaluation, Override, SharingMode, SignalWindow, Tier, WeightMults } from "../types.ts";

export type DriverRow = { id: string; sharingMode: SharingMode; weightOverrides: Partial<WeightMults> };

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

export type WindowRow = { tripId: string; ts: string; raw: SignalWindow; result: Evaluation; score: number; tier: Tier };

export type EventRow = { tripId: string; ts: string; tier: Tier; actions: Action[]; override: Override | null };

export interface RiskStore {
  /** Create the driver if missing; returns the stored row. */
  upsertDriver(id: string, sharingMode?: SharingMode): Promise<DriverRow>;
  getDriver(id: string): Promise<DriverRow | null>;
  setWeightOverrides(id: string, overrides: Partial<WeightMults>): Promise<void>;

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
}
