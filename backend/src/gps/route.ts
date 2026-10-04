// GPS part of the trip report card. Pure: stored fixes and events in, card section out.
//   route          one point per 10 s (the first fix in each 10 s bucket)
//   alerts         one marker per fired alert event, placed at the fix nearest in time
//   pct_over_limit share of the trip's fixes whose speed was over a known limit
//   pct_fallback   share of the trip's fixes whose limit came from the hand-set fallback table
// Both percentages use every fix of the trip (stopped time included) as the denominator.
import type { Tier } from "../risk/types.ts";

export type GpsSampleRow = { time: string; lat: number; lon: number; speedMps: number | null; limitMps: number | null; limitSource: string | null };
export type GpsEvent = { ts: string; tier: Tier };

export type GpsCard = {
  samples: number;
  route: { t: string; lat: number; lon: number }[];
  alerts: { t: string; tier: Tier; lat: number; lon: number }[];
  pct_over_limit: number;
  pct_fallback_limit: number;
  /** True when any limit came from the fallback table; the note says so, per the spec. */
  fallback_used: boolean;
  limit_note: string | null;
};

const BUCKET_MS = 10_000;
const MARKER_MAX_GAP_MS = 30_000;
const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);

export function buildGpsCard(samples: GpsSampleRow[], events: GpsEvent[]): GpsCard | null {
  if (!samples.length) return null;
  const rows = samples.map((s) => ({ ...s, ms: Date.parse(s.time) })).sort((a, b) => a.ms - b.ms);

  const route: GpsCard["route"] = [];
  let bucket = -1;
  for (const r of rows) {
    const b = Math.floor(r.ms / BUCKET_MS);
    if (b === bucket) continue;
    bucket = b;
    route.push({ t: r.time, lat: r.lat, lon: r.lon });
  }

  const alerts: GpsCard["alerts"] = [];
  for (const e of events) {
    if (e.tier < 1) continue;
    const ms = Date.parse(e.ts);
    const nearest = rows.reduce((b, r) => (Math.abs(r.ms - ms) < Math.abs(b.ms - ms) ? r : b), rows[0]!);
    if (Math.abs(nearest.ms - ms) <= MARKER_MAX_GAP_MS) alerts.push({ t: e.ts, tier: e.tier, lat: nearest.lat, lon: nearest.lon });
  }

  const over = rows.filter((r) => r.speedMps != null && r.limitMps != null && r.speedMps > r.limitMps).length;
  const fallback = rows.filter((r) => r.limitSource === "fallback").length;
  const pctFallback = pct(fallback, rows.length);
  return {
    samples: rows.length,
    route,
    alerts,
    pct_over_limit: pct(over, rows.length),
    pct_fallback_limit: pctFallback,
    fallback_used: fallback > 0,
    limit_note: fallback > 0 ? `${pctFallback}% of the trip used a hand-set limit by road class because OpenStreetMap had no posted speed.` : null,
  };
}
