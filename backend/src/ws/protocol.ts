// WebSocket contract between the Android app and this backend.
// Every frame is a single JSON object with a `type` field.
// Share this file (or PROTOCOL.md) with the Android side; keep them in sync.
import { z } from "zod";

export const SharingMode = z.enum(["always", "high_only", "never"]);
export type SharingMode = z.infer<typeof SharingMode>;

export const Tier = z.union([z.literal(40), z.literal(70), z.literal(85)]);
export type Tier = z.infer<typeof Tier>;

export const Dominant = z.enum(["drowsy", "reckless"]);
export type Dominant = z.infer<typeof Dominant>;

export const DriverEvent = z.enum(["yawn", "nod", "hard_brake", "swerve"]);
export type DriverEvent = z.infer<typeof DriverEvent>;

export const SpeakContext = z.enum(["checkin", "after_message", "permission", "roast", "info"]);
export type SpeakContext = z.infer<typeof SpeakContext>;

// ---- phone -> backend ------------------------------------------------------

export const PhoneMsg = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    driverName: z.string().optional(),
    sharingMode: SharingMode.default("high_only"),
    kidsInCar: z.boolean().default(false),
    lowExperience: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("settings"),
    sharingMode: SharingMode.optional(),
    kidsInCar: z.boolean().optional(),
    lowExperience: z.boolean().optional(),
  }),
  z.object({ type: z.literal("trip_start") }),
  z.object({ type: z.literal("trip_end") }),
  z.object({
    type: z.literal("risk_window"),
    ts: z.number(), // epoch ms, end of the 10 s window
    R: z.number(), // 0..100 combined risk
    drowsy: z.number(), // drowsy sub-score 0..100
    reckless: z.number(), // reckless sub-score 0..100
    speed: z.number().default(0), // mph
    lat: z.number().optional(),
    lon: z.number().optional(),
    events: z.array(DriverEvent).default([]),
    features: z.record(z.string(), z.number()).optional(),
  }),
  // Raw ~1 Hz signals. If the phone sends these, the backend runs the risk
  // engine (backend/src/risk) and produces windows and alerts itself, so the
  // phone does not need to send `risk_window` / `alert`. Presage fields are
  // omitted when the face is lost.
  z.object({
    type: z.literal("sensor_sample"),
    ts: z.number(),
    hr: z.number().optional(),
    breathing: z.number().optional(),
    engagement: z.number().min(0).max(1).optional(),
    eyeClosure: z.number().min(0).max(1).optional(),
    stress: z.number().min(0).max(1).optional(),
    yawn: z.boolean().optional(),
    nod: z.boolean().optional(),
    gazeOff: z.boolean().optional(),
    speed: z.number().optional(),
    speedLimit: z.number().optional(),
    hardBrake: z.boolean().optional(),
    swerve: z.boolean().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
  }),
  z.object({
    type: z.literal("alert"),
    tier: Tier,
    dominant: Dominant,
    R: z.number(),
  }),
  // Speech-to-text result. `context` echoes the `speak.context` the phone was
  // listening after, or "free" for push-to-talk / wake word.
  z.object({
    type: z.literal("utterance"),
    text: z.string(),
    context: z.enum(["checkin", "after_message", "permission", "roast", "free"]).default("free"),
  }),
  // Phone finished playing a `speak` (and its listen window, if any).
  z.object({ type: z.literal("speak_done"), id: z.string() }),
]);
export type PhoneMsg = z.infer<typeof PhoneMsg>;

// ---- backend -> phone ------------------------------------------------------

export type BackendMsg =
  | {
      type: "speak";
      id: string;
      text: string;
      tier: Tier | 0;
      audio: string; // base64 mp3 ("" if TTS failed; phone may fall back to on-device TTS)
      listenAfterMs: number; // 0 = don't listen
      context: SpeakContext;
    }
  | { type: "navigate"; query: string }
  | { type: "dismissed" }
  | { type: "error"; message: string };
