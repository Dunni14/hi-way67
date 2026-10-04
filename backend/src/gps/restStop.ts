// Nearest rest area or fuel station ahead of the heading (Overpass). Used by the voice agent as a
// parameter on the existing rest recommendation, not as a separate bandit action.
import type { RiskConfig } from "../risk/config.ts";
import { bearingDeg, distanceM } from "./geo.ts";
import { overpass, overpassUrlsFromEnv, type FetchLike, type OsmElement, type OverpassResult } from "./overpass.ts";
import type { LocationFix } from "./types.ts";

export type RestStop = { kind: "rest_area" | "fuel"; name: string | null; distance_m: number; lat: number; lon: number };

const angleBetween = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Nearest candidate within the cone around the heading (anywhere in the radius when the heading is unknown). */
export function pickStop(elements: OsmElement[], from: { lat: number; lon: number; heading_deg: number | null }, cfg: RiskConfig): RestStop | null {
  const R = cfg.gps.restStop;
  let best: RestStop | null = null;
  for (const el of elements) {
    const at = el.center ?? (el.lat != null && el.lon != null ? { lat: el.lat, lon: el.lon } : null);
    if (!at) continue;
    const d = distanceM(from, at);
    if (d > R.radiusKm * 1000) continue;
    // Too close to have a meaningful bearing: it is effectively here, count it as ahead.
    if (from.heading_deg != null && d > 100 && angleBetween(bearingDeg(from, at), from.heading_deg) > R.coneDeg) continue;
    if (!best || d < best.distance_m) {
      best = { kind: el.tags?.amenity === "fuel" ? "fuel" : "rest_area", name: el.tags?.name ?? el.tags?.brand ?? null, distance_m: d, lat: at.lat, lon: at.lon };
    }
  }
  return best;
}

export type RestStopOpts = { endpoints?: string[]; fetch?: FetchLike; now?: () => number };

export class RestStopFinder {
  private cache = new Map<string, { at: number; stop: RestStop | null }>();
  private endpoints: string[];
  private now: () => number;

  constructor(private cfg: RiskConfig, private opts: RestStopOpts = {}) {
    this.endpoints = opts.endpoints ?? overpassUrlsFromEnv();
    this.now = opts.now ?? Date.now;
  }

  /** Resolves null when nothing is found or Overpass fails or times out. Never rejects. */
  async next(fix: Pick<LocationFix, "lat" | "lon" | "heading_deg">): Promise<RestStop | null> {
    const R = this.cfg.gps.restStop;
    // ~1 km cells, 5 minute cache: the answer barely changes and public Overpass is rate limited.
    const key = `${fix.lat.toFixed(2)},${fix.lon.toFixed(2)},${Math.round((fix.heading_deg ?? -1) / 45)}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < 5 * 60_000) return hit.stop;
    const around = `(around:${Math.round(R.radiusKm * 1000)},${fix.lat},${fix.lon})`;
    const query = `[out:json][timeout:${Math.max(1, Math.round(R.timeoutMs / 1000))}];(nwr${around}["highway"="rest_area"];nwr${around}["amenity"="fuel"];);out center tags;`;
    try {
      const res = await overpass<OverpassResult>(query, { endpoints: this.endpoints, timeoutMs: R.timeoutMs, fetch: this.opts.fetch });
      const stop = pickStop(res.elements ?? [], fix, this.cfg);
      this.cache.set(key, { at: this.now(), stop });
      return stop;
    } catch (err) {
      console.warn(`[gps] rest stop lookup failed: ${(err as Error).message}`);
      return null;
    }
  }
}

const METERS_PER_MILE = 1609.344;
export const milesAhead = (stop: RestStop) => stop.distance_m / METERS_PER_MILE;
