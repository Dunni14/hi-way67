// Shared types and request schemas for the risk engine. Field names are our own
// internal schema; the client maps Presage SDK output into it.
import { z } from "zod";
import { GpsPayload, type LimitSource } from "../gps/types.ts";

const num = z.number().nullish();

export const SignalWindow = z.object({
  ts: z.string(), // ISO 8601, end of the 10 s window
  face_visible: z.boolean().nullish(),
  heart_rate: num,
  breathing_rate: num,
  engagement: num, // 0..1, 1 = engaged
  eye_closure_frac: num,
  longest_eye_closure_s: num,
  yawns: num,
  emotion_stress: num,
  gaze_off_road_s: num,
  phone_in_hand: z.boolean().nullish(),
  hard_brakes: num,
  swerves: num,
  speed_mph: num,
  speed_limit_mph: num,
  /**
   * Phone GPS fixes for this window. Absent: legacy payload, `speed_mph` / `speed_limit_mph` are used as
   * sent. `null` (permission denied, no fix) or present: GPS is authoritative and `speeding` is 0 unless
   * there are enough good fixes and a known limit.
   */
  gps: GpsPayload.nullish(),
});
export type SignalWindow = z.infer<typeof SignalWindow>;

/**
 * What the pure core scores: the client window with `gps` reduced by the service to the levels it
 * feeds. These are stored with the window (not the raw fixes) so a restart can replay them.
 */
export type EngineWindow = Omit<SignalWindow, "gps"> & {
  /** 0..1 speeding level from GPS speed against the posted limit. Set whenever the client sent `gps`. */
  gps_speeding?: number | null;
  /** 0..1 erratic level from GPS acceleration and heading change. */
  gps_erratic?: number | null;
  /** Good GPS and under the stop speed: speeding and erratic are not scored. */
  gps_stopped?: boolean | null;
  limit_source?: LimitSource | null;
};

export const TripStart = z.object({
  driver_id: z.string().min(1),
  kids_in_car: z.boolean().default(false),
  low_experience: z.boolean().default(false),
  sleep_hours: z.number().nullish(),
  /** Location sharing with contacts. Omitted keeps the driver's stored choice (default on). */
  share_location: z.boolean().optional(),
});
export type TripStart = z.infer<typeof TripStart>;

export const Feedback = z.object({
  window_ts: z.string(),
  verdict: z.enum(["false_alarm", "confirmed"]),
});
export type Feedback = z.infer<typeof Feedback>;

export const FACTORS = ["agitated", "speeding", "drowsy", "phone", "distracted", "erratic"] as const;
export type Factor = (typeof FACTORS)[number];
export type Levels = Record<Factor, number>;
/** Per-driver multiplier on each factor weight (default 1, clamped by config). */
export type WeightMults = Record<Factor, number>;

export type Tier = 0 | 1 | 2 | 3;
export type Action = "none" | "voice_nudge" | "voice_warning" | "voice_urgent" | "notify_contacts" | "ask_permission_to_notify";
export type Override = "microsleep" | "drowsy_sustained_3" | "drowsy_sustained_12" | "tier2_sustained_12";
export type SharingMode = "always" | "high_only" | "never";

export type Evaluation = {
  score: number;
  tier: Tier;
  dominant: "drowsy" | "reckless";
  actions: Action[];
  levels: Levels;
  override: Override | null;
  degraded: boolean;
  /** Present when the window carried a `gps` field. No coordinates: the phone already has those. */
  gps?: GpsSummary;
};

export type GpsSummary = {
  ok: boolean;
  speed_mps: number | null;
  limit_mph: number | null;
  limit_source: LimitSource;
  /** Stopped, so speeding and erratic were not scored. */
  stopped: boolean;
  /** Set once the trip has been moving (speed above the start speed long enough). */
  moving: boolean;
  /** The trip ended itself on this window (speed under the stop speed long enough); send no more windows. */
  trip_ended?: boolean;
};

/** Trip-level context set at trip start. */
export type TripContext = {
  kidsInCar: boolean;
  lowExperience: boolean;
  sleepHours: number | null;
  /** Sharing off for the driver -> ask permission instead of notifying. */
  sharingOn: boolean;
};
