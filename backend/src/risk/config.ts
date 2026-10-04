// All weights and thresholds live in weights.json; nothing is hardcoded in the logic.
import { z } from "zod";
import raw from "./weights.json" with { type: "json" };

const pos = z.number().positive();
const Config = z.object({
  factors: z.object({ agitated: pos, speeding: pos, drowsy: pos, phone: pos, distracted: pos, erratic: pos }),
  sleep: z.array(z.object({ underHours: z.number(), add: z.number() })),
  oddsCap: pos,
  context: z.object({ kids_in_car: z.number(), low_experience: z.number() }),
  levels: z.object({
    drowsy: z.object({ eyeClosure: z.number(), eyeClosureFull: pos, yawns: z.number(), yawnsFull: pos, engagement: z.number(), breathing: z.number(), breathingFull: pos }),
    agitated: z.object({ stress: z.number(), heartRate: z.number(), heartRateFull: pos }),
    speedingFullMph: pos,
    distractedFullS: pos,
    erraticFull: pos,
  }),
  tiers: z.object({ nudge: pos, warning: pos, urgent: pos }),
  baselineWindows: z.number().int().positive(),
  smoothingWindows: z.number().int().positive(),
  holdWindows: z.number().int().positive(),
  overrides: z.object({
    microsleepS: pos,
    microsleepRepeatS: pos,
    drowsyNudgeLevel: pos,
    drowsyNudgeOf: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    drowsyLevel: pos,
    drowsyFloorWindows: z.number().int().positive(),
    drowsyFloorOf: z.number().int().positive(),
    drowsyUrgentWindows: z.number().int().positive(),
    tier2UrgentWindows: z.number().int().positive(),
  }),
  cooldownS: pos,
  notifyCooldownS: pos,
  degradedAfterWindows: z.number().int().positive(),
  feedback: z.object({ falseAlarm: pos, confirmed: pos, min: pos, max: pos }),
  expression: z.object({ drowsyEye: pos, drowsyYawns: pos, drowsyClosureS: pos, stress: pos, gazeS: pos, calmEngagement: pos, calmStress: pos }),
  report: z.object({
    formulaVersion: z.number().int().positive(),
    penalty: z.object({ meanRisk: z.number(), p90Risk: z.number(), tier2Frac: z.number(), tier3Frac: z.number(), microsleep: z.number(), microsleepCap: pos }),
    highLevel: pos,
    grades: z.object({ A: z.number(), B: z.number(), C: z.number(), D: z.number() }),
    minWindows: z.number().int().positive(),
    fullConfidenceWindows: pos,
  }),
  gps: z.object({
    /** Fraction over the posted limit that maps to speeding = 1. */
    speedingOverFull: pos,
    accuracyMaxM: pos,
    minGoodFixes: z.number().int().positive(),
    /** Heading is noise below this speed and is ignored. */
    headingMinSpeedMps: z.number().min(0),
    erratic: z.object({ accelLow: z.number(), accelFull: z.number(), headingLow: z.number(), headingFull: z.number() }),
    /** Posted limit (mph) by OSM `highway` class when a way has no usable `maxspeed`. */
    fallbackLimitsMph: z.record(z.string(), pos),
    trip: z.object({ startSpeedMps: pos, startHoldS: pos, stopSpeedMps: pos, stopHoldS: pos }),
    lookup: z.object({ radiusM: pos, timeoutMs: pos, cacheMax: z.number().int().positive(), cacheTtlS: pos, failureBackoffS: pos, maxInflight: z.number().int().positive() }),
    restStop: z.object({ radiusKm: pos, coneDeg: pos, timeoutMs: pos }),
    /** A fix older than this is reported as stale to contacts. */
    staleFixS: pos,
  }),
  adaptive: z.object({
    careNeutral: z.number(),
    careAlpha: pos,
    shiftPerPoint: z.number(),
    minNotify: pos,
    maxNotify: pos,
    learnedClamp: pos,
    falseAlarmShift: z.number(),
    confirmedShift: z.number(),
  }),
});

export type RiskConfig = z.infer<typeof Config>;
export const riskConfig: RiskConfig = Config.parse(raw);
