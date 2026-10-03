// Live, in-memory view of the current trip. Fed by `risk_window` / `alert`
// frames from the phone; read by the agent to answer questions.
import type { Dominant, DriverEvent, SharingMode, Tier } from "../ws/protocol.ts";
import { config } from "../config.ts";

type Window = {
  ts: number;
  R: number;
  drowsy: number;
  reckless: number;
  speed: number;
  lat?: number;
  lon?: number;
  events: DriverEvent[];
};

const KEEP_WINDOWS_MS = 30 * 60_000;

export class TripState {
  driverName = config.driverName;
  sharingMode: SharingMode = "high_only";
  kidsInCar = false;

  tripId: string | null = null;
  startedAt = 0;
  windows: Window[] = [];
  maxR = 0;
  alertCount = 0;
  lastAlert: { tier: Tier; dominant: Dominant; R: number; at: number } | null = null;
  lastHighAlertAt = 0;

  get active() {
    return this.tripId !== null;
  }

  get latest(): Window | undefined {
    return this.windows.at(-1);
  }

  start(now = Date.now()) {
    this.tripId = `trip-${now}`;
    this.startedAt = now;
    this.windows = [];
    this.maxR = 0;
    this.alertCount = 0;
    this.lastAlert = null;
    this.lastHighAlertAt = 0;
  }

  end() {
    this.tripId = null;
  }

  addWindow(w: Window) {
    this.windows.push(w);
    this.maxR = Math.max(this.maxR, w.R);
    const cutoff = w.ts - KEEP_WINDOWS_MS;
    while (this.windows.length && this.windows[0]!.ts < cutoff) this.windows.shift();
  }

  recordAlert(tier: Tier, dominant: Dominant, R: number, now = Date.now()) {
    this.alertCount++;
    this.lastAlert = { tier, dominant, R, at: now };
    if (tier >= 85) this.lastHighAlertAt = now;
  }

  countEvents(event: DriverEvent, sinceMs: number, now = Date.now()) {
    return this.windows
      .filter((w) => w.ts >= now - sinceMs)
      .reduce((n, w) => n + w.events.filter((e) => e === event).length, 0);
  }

  /** Stopped = every window in the last minute under 3 mph. */
  isStopped(now = Date.now()) {
    const recent = this.windows.filter((w) => w.ts >= now - 60_000);
    return recent.length > 0 && recent.every((w) => w.speed < 3);
  }

  drivingMinutes(now = Date.now()) {
    return this.active ? Math.round((now - this.startedAt) / 60_000) : 0;
  }

  mapsLink() {
    const w = this.latest;
    if (w?.lat == null || w.lon == null) return null;
    return `https://maps.google.com/?q=${w.lat.toFixed(5)},${w.lon.toFixed(5)}`;
  }
}

export const trip = new TripState();
