// Shapes shared by the GPS modules. Field names in `GpsPayload` are final (see docs/gps.md).
import { z } from "zod";

const num = z.number().nullish();

export const GpsFix = z.object({
  t: z.string(), // ISO 8601
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  speed_mps: num,
  heading_deg: num,
  h_accuracy_m: num,
});
export type GpsFix = z.infer<typeof GpsFix>;

/** Up to 10 fixes per 10 s payload. `gps: null` means no permission or no fix. */
export const GpsPayload = z.object({ fixes: z.array(GpsFix).max(10) });
export type GpsPayload = z.infer<typeof GpsPayload>;

/** A fix that passed the accuracy and speed checks, with a parsed time. */
export type GoodFix = { ms: number; t: string; lat: number; lon: number; speed_mps: number; heading_deg: number | null; h_accuracy_m: number };

export type WindowGps = {
  good: GoodFix[];
  /** Median fix speed. */
  speed_mps: number | null;
  speed_max_mps: number | null;
  accel_max_mps2: number | null;
  heading_rate_dps: number | null;
  /** Last good fix. */
  last: GoodFix | null;
  gps_ok: boolean;
};

export type LimitSource = "osm" | "fallback" | "none";
export type SpeedLimit = { limit_mps: number | null; source: LimitSource };

/** What the in-process consumers (voice, Photon) get about the last good fix. */
export type LocationFix = { ms: number; lat: number; lon: number; speed_mps: number | null; heading_deg: number | null };

export const MPS_PER_MPH = 0.44704;
export const mphToMps = (mph: number) => mph * MPS_PER_MPH;
export const mpsToMph = (mps: number) => mps / MPS_PER_MPH;
