// Live, in-memory view of the current trip. Fed by `risk_window` / `alert`
// frames from the phone; read by the agent to answer questions.
import type { Dominant, DriverEvent, SharingMode, Tier } from "../ws/protocol.ts";
import { config } from "../config.ts";
import { reverseGeocode } from "../gps/geocode.ts";
import { endLocationLine, locationLine, mapsLink } from "../gps/message.ts";
import { MPS_PER_MPH, type LocationFix } from "../gps/types.ts";
import { riskConfig } from "../risk/config.ts";

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

/** Last good GPS fix; `place` is the reverse-geocoded "Road, City" once looked up. */
export type Fix = LocationFix & { place?: string | null };

export class TripState {
  driverName = config.driverName;
  sharingMode: SharingMode = "high_only";
  kidsInCar = false;
  /**
   * Driver's location-sharing setting. Every path that puts a position in front of Photon (alerts, chat
   * answers, geocoding) goes through the methods below, and they return nothing while this is off.
   */
  shareLocation = true;
  /** Last good fix. Kept after the trip ends so the agent can say where it ended. */
  lastFix: Fix | null = null;
  endedAt: number | null = null;

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
    this.lastFix = null;
    this.endedAt = null;
  }

  end(now = Date.now()) {
    this.tripId = null;
    this.endedAt = now;
  }

  setFix(fix: LocationFix) {
    if (this.lastFix && fix.ms < this.lastFix.ms) return;
    const same = this.lastFix && this.lastFix.lat === fix.lat && this.lastFix.lon === fix.lon;
    this.lastFix = { ...fix, place: same ? this.lastFix!.place : undefined };
  }

  addWindow(w: Window) {
    if (w.lat != null && w.lon != null) this.setFix({ ms: w.ts, lat: w.lat, lon: w.lon, speed_mps: w.speed * MPS_PER_MPH, heading_deg: null });
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

  /** Maps link for the last good fix, or null with no fix or sharing off. */
  mapsLink() {
    return this.shareLocation && this.lastFix ? mapsLink(this.lastFix) : null;
  }

  /** Looks up the road and city of the last fix (once per position). Best effort; no-op when sharing is off. */
  async resolvePlace() {
    const fix = this.lastFix;
    if (!this.shareLocation || !fix || fix.place !== undefined) return;
    fix.place = await reverseGeocode(fix.lat, fix.lon);
  }

  /** Link, speed and time of the last fix (road and city once resolved), or null. Marks a fix older than staleFixS. */
  locationText(now = Date.now()) {
    return this.shareLocation ? locationLine(this.lastFix, this.lastFix?.place ?? null, now, riskConfig.gps.staleFixS) : null;
  }

  /** Where the last trip ended and when, or null with no fix, no end or sharing off. */
  endLocationText() {
    return this.shareLocation && this.lastFix && this.endedAt ? endLocationLine(this.lastFix, this.lastFix.place ?? null, this.endedAt) : null;
  }
}

export const trip = new TripState();
