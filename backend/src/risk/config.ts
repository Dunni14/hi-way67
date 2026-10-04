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
    drowsyLevel: pos,
    drowsyFloorWindows: z.number().int().positive(),
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
