// Posted speed limit from OpenStreetMap (Overpass). The scoring path only ever calls `lookup`, which
// answers synchronously from the cache or the last known limit; the network fetch runs in the
// background and its result is used from the next lookup on. So a slow or dead Overpass costs a
// stale limit, never a late score.
import type { RiskConfig } from "../risk/config.ts";
import { nearestOnPolyline, undirectedDelta } from "./geo.ts";
import { overpass, overpassUrlsFromEnv, type FetchLike, type OsmElement, type OverpassResult } from "./overpass.ts";
import { mphToMps, type SpeedLimit } from "./types.ts";

const NONE: SpeedLimit = { limit_mps: null, source: "none" };

/** Driveable classes. Service and living streets are included so they are picked (and give `none`) instead of a neighbouring road's limit. */
const HIGHWAY = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service";

/** OSM `maxspeed` to mph. A bare number is km/h (the OSM default). Anything else ("none", "signals", lists) is not usable. */
export function parseMaxspeed(v: string | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(v ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  return (m[2] ?? "kph").toLowerCase() === "mph" ? n : n / 1.609344;
}

/** Limit for a way: its own `maxspeed` (source osm), else the hand-set fallback for its highway class (source fallback), else none. */
export function limitForWay(tags: Record<string, string> | undefined, cfg: RiskConfig): SpeedLimit {
  const own = parseMaxspeed(tags?.maxspeed);
  if (own != null) return { limit_mps: mphToMps(own), source: "osm" };
  const cls = (tags?.highway ?? "").replace(/_link$/, "");
  const fb = cfg.gps.fallbackLimitsMph[cls];
  return fb != null ? { limit_mps: mphToMps(fb), source: "fallback" } : NONE;
}

/** The way within the radius whose bearing best matches the heading (nearest when heading is unknown). */
export function pickWay(elements: OsmElement[], at: { lat: number; lon: number }, headingDeg: number | null, radiusM: number): OsmElement | null {
  let best: { el: OsmElement; cost: number } | null = null;
  for (const el of elements) {
    if (el.type !== "way" || !el.geometry) continue;
    const near = nearestOnPolyline(at, el.geometry);
    if (!near || near.distanceM > radiusM + 5) continue;
    // Bearing counts most; distance breaks ties between parallel ways (hand-set 0.5 weight).
    const cost = (headingDeg == null ? 0 : undirectedDelta(near.bearing, headingDeg) / 90) + (0.5 * near.distanceM) / radiusM;
    if (!best || cost < best.cost) best = { el, cost };
  }
  return best?.el ?? null;
}

export type SpeedLimitOpts = { endpoints?: string[]; fetch?: FetchLike; now?: () => number };

export class SpeedLimitProvider {
  private cache = new Map<string, { at: number; value: SpeedLimit }>();
  private last = new Map<string, SpeedLimit>();
  private latestKey = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();
  private backoffUntil = 0;
  private warnedAt = 0;
  private endpoints: string[];
  private now: () => number;

  constructor(private cfg: RiskConfig, private opts: SpeedLimitOpts = {}) {
    this.endpoints = opts.endpoints ?? overpassUrlsFromEnv();
    this.now = opts.now ?? Date.now;
  }

  /** Never blocks. `tripKey` scopes the "last known limit" so trips do not see each other's. */
  lookup(tripKey: string, lat: number, lon: number, headingDeg: number | null): SpeedLimit {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    this.latestKey.set(tripKey, key);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cfg.gps.lookup.cacheTtlS * 1000) {
      this.last.set(tripKey, hit.value);
      return hit.value;
    }
    this.fetchInBackground(key, lat, lon, headingDeg);
    return this.last.get(tripKey) ?? NONE;
  }

  forget(tripKey: string) {
    this.last.delete(tripKey);
    this.latestKey.delete(tripKey);
  }

  /** Resolves when no lookup is in flight. For tests and shutdown. */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  private fetchInBackground(key: string, lat: number, lon: number, headingDeg: number | null) {
    const L = this.cfg.gps.lookup;
    if (this.inflight.has(key) || this.inflight.size >= L.maxInflight || this.now() < this.backoffUntil) return;
    const query = `[out:json][timeout:${Math.max(1, Math.round(L.timeoutMs / 1000))}];way(around:${L.radiusM},${lat},${lon})["highway"~"^(${HIGHWAY})$"];out tags geom;`;
    const p = overpass<OverpassResult>(query, { endpoints: this.endpoints, timeoutMs: L.timeoutMs, fetch: this.opts.fetch })
      .then((res) => {
        const way = pickWay(res.elements ?? [], { lat, lon }, headingDeg, L.radiusM);
        const value = way ? limitForWay(way.tags, this.cfg) : NONE;
        this.cache.set(key, { at: this.now(), value });
        if (this.cache.size > L.cacheMax) this.cache.delete(this.cache.keys().next().value!);
        // A trip still sitting on this segment gets the answer immediately instead of at its next lookup.
        for (const [trip, k] of this.latestKey) if (k === key) this.last.set(trip, value);
      })
      .catch((err: Error) => {
        this.backoffUntil = this.now() + L.failureBackoffS * 1000;
        if (this.now() - this.warnedAt > 60_000) {
          this.warnedAt = this.now();
          console.warn(`[gps] speed limit lookup failed, backing off ${L.failureBackoffS}s: ${err.message}`);
        }
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
  }
}
