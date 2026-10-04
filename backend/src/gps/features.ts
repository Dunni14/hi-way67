// Window features from one payload's fixes, and the speeding / erratic levels they feed.
// Pure: no I/O, thresholds come from config (weights.json -> gps, mirrored in the `settings` table).
import type { RiskConfig } from "../risk/config.ts";
import type { GoodFix, GpsFix, WindowGps } from "./types.ts";

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Smallest absolute angle between two compass headings, 0..180. 359 -> 1 is 2, not 358. */
export function headingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Drops fixes the spec says to drop: horizontal accuracy worse than the cutoff (or unknown), a negative
 * or missing speed, or an unparsable time. A negative heading (the platforms' "no heading" value) is
 * kept as a fix with no heading. Returned in time order.
 */
export function goodFixes(fixes: GpsFix[], cfg: RiskConfig): GoodFix[] {
  const out: GoodFix[] = [];
  for (const f of fixes) {
    const ms = Date.parse(f.t);
    if (Number.isNaN(ms)) continue;
    if (f.h_accuracy_m == null || !(f.h_accuracy_m >= 0) || f.h_accuracy_m > cfg.gps.accuracyMaxM) continue;
    if (f.speed_mps == null || !(f.speed_mps >= 0)) continue;
    const heading = f.heading_deg != null && f.heading_deg >= 0 && f.heading_deg <= 360 ? f.heading_deg % 360 : null;
    out.push({ ms, t: new Date(ms).toISOString(), lat: f.lat, lon: f.lon, speed_mps: f.speed_mps, heading_deg: heading, h_accuracy_m: f.h_accuracy_m });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Per-fix acceleration (m/s^2) and heading rate (deg/s) against the previous fix; null when not defined. */
export function motionBetween(prev: GoodFix, cur: GoodFix, cfg: RiskConfig): { accel: number | null; headingRate: number | null } {
  const dt = (cur.ms - prev.ms) / 1000;
  if (!(dt > 0)) return { accel: null, headingRate: null };
  const accel = Math.abs(cur.speed_mps - prev.speed_mps) / dt;
  const fast = Math.min(prev.speed_mps, cur.speed_mps) >= cfg.gps.headingMinSpeedMps;
  const headingRate = fast && prev.heading_deg != null && cur.heading_deg != null ? headingDelta(prev.heading_deg, cur.heading_deg) / dt : null;
  return { accel, headingRate };
}

export function windowFeatures(fixes: GpsFix[], cfg: RiskConfig): WindowGps {
  const good = goodFixes(fixes, cfg);
  let accel: number | null = null;
  let heading: number | null = null;
  for (let i = 1; i < good.length; i++) {
    const m = motionBetween(good[i - 1]!, good[i]!, cfg);
    if (m.accel != null) accel = Math.max(accel ?? 0, m.accel);
    if (m.headingRate != null) heading = Math.max(heading ?? 0, m.headingRate);
  }
  const speeds = good.map((f) => f.speed_mps);
  return {
    good,
    speed_mps: speeds.length ? median(speeds) : null,
    speed_max_mps: speeds.length ? Math.max(...speeds) : null,
    accel_max_mps2: accel,
    heading_rate_dps: heading,
    last: good.at(-1) ?? null,
    gps_ok: good.length >= cfg.gps.minGoodFixes,
  };
}

/** 0 at or under the limit, 1 at `speedingOverFull` (30 percent) over. No limit or no good GPS: 0, never a guess. */
export function speedingLevel(speedMps: number | null, limitMps: number | null, gpsOk: boolean, cfg: RiskConfig): number {
  if (!gpsOk || speedMps == null || limitMps == null || !(limitMps > 0)) return 0;
  return clamp01((speedMps - limitMps) / limitMps / cfg.gps.speedingOverFull);
}

/** max of the hard-acceleration level and the heading-change level; combined with the phone motion signal in levels.ts. */
export function erraticGpsLevel(f: Pick<WindowGps, "accel_max_mps2" | "heading_rate_dps" | "gps_ok">, cfg: RiskConfig): number {
  if (!f.gps_ok) return 0;
  const E = cfg.gps.erratic;
  const a = f.accel_max_mps2 == null ? 0 : clamp01((f.accel_max_mps2 - E.accelLow) / (E.accelFull - E.accelLow));
  const h = f.heading_rate_dps == null ? 0 : clamp01((f.heading_rate_dps - E.headingLow) / (E.headingFull - E.headingLow));
  return Math.max(a, h);
}

/** Stopped = good GPS and median speed under the stop threshold. Speeding and erratic are not scored while stopped. */
export const isStopped = (f: Pick<WindowGps, "speed_mps" | "gps_ok">, cfg: RiskConfig) =>
  f.gps_ok && f.speed_mps != null && f.speed_mps < cfg.gps.trip.stopSpeedMps;
