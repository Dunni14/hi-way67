// Persistence boundary. The Tiger Data (Timescale) implementation lives with
// the teammate who owns it; it only has to satisfy `TripStore`.

export type WindowRecord = {
  tripId: string;
  ts: number;
  R: number;
  drowsy: number;
  reckless: number;
  speed: number;
  lat?: number;
  lon?: number;
  events: string[];
  features?: Record<string, number>;
};

export type TripSummary = {
  tripId: string;
  driverName: string;
  startedAt: number;
  endedAt?: number;
  maxR: number;
  alerts: number;
};

export type ContactPrefs = { notifyOnArrival?: boolean };

export interface TripStore {
  startTrip(trip: TripSummary): Promise<void>;
  endTrip(tripId: string, patch: Partial<TripSummary>): Promise<void>;
  saveWindow(w: WindowRecord): Promise<void>;
  getRecentTrips(driverName: string, sinceMs: number): Promise<TripSummary[]>;
  getContactPrefs(handle: string): Promise<ContactPrefs>;
  setContactPrefs(handle: string, prefs: ContactPrefs): Promise<void>;
}

export class InMemoryTripStore implements TripStore {
  private trips = new Map<string, TripSummary>();
  private windows: WindowRecord[] = [];
  private prefs = new Map<string, ContactPrefs>();

  async startTrip(trip: TripSummary) {
    this.trips.set(trip.tripId, { ...trip });
  }

  async endTrip(tripId: string, patch: Partial<TripSummary>) {
    const trip = this.trips.get(tripId);
    if (trip) Object.assign(trip, patch);
  }

  async saveWindow(w: WindowRecord) {
    this.windows.push(w);
  }

  async getRecentTrips(driverName: string, sinceMs: number) {
    return [...this.trips.values()].filter((t) => t.driverName === driverName && t.startedAt >= sinceMs);
  }

  async getContactPrefs(handle: string) {
    return this.prefs.get(handle) ?? {};
  }

  async setContactPrefs(handle: string, prefs: ContactPrefs) {
    this.prefs.set(handle, { ...this.prefs.get(handle), ...prefs });
  }
}
