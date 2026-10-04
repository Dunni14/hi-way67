// Every constant and the action table live in bandit.json; nothing is hardcoded in the logic.
import { z } from "zod";
import raw from "./bandit.json" with { type: "json" };

const pos = z.number().positive();
const Dominant = z.enum(["drowsy", "reckless"]);
const Config = z
  .object({
    alpha: z.number().nonnegative(),
    defaultBias: z.number(),
    rewardDelayS: pos,
    rewardScale: pos,
    beforeWindows: z.number().int().positive(),
    afterWindows: z.number().int().positive(),
    windowS: pos,
    stopS: pos,
    faceHiddenMajority: z.number().min(0).max(1),
    context: z.object({ tripMinutesFull: pos, interventionsFull: pos, nightStartHour: z.number(), nightEndHour: z.number() }),
    adjustments: z.object({ stopped: z.number(), falseAlarm: z.number(), tierUp: z.number() }),
    rewardMin: z.number(),
    rewardMax: z.number(),
    defaults: z.object({ 1: z.object({ drowsy: z.string(), reckless: z.string() }), 2: z.object({ drowsy: z.string(), reckless: z.string() }) }),
    actions: z.record(
      z.string(),
      z.object({ tiers: z.array(z.union([z.literal(1), z.literal(2)])).min(1), dominant: z.enum(["drowsy", "reckless", "both"]), requiresFamilyVoice: z.boolean().optional() }),
    ),
  })
  .superRefine((c, ctx) => {
    for (const tier of [1, 2] as const)
      for (const dom of Dominant.options) {
        const id = c.defaults[tier][dom];
        const a = c.actions[id];
        if (!a || !a.tiers.includes(tier) || (a.dominant !== "both" && a.dominant !== dom) || a.requiresFamilyVoice)
          ctx.addIssue({ code: "custom", message: `default ${id} is not a plain allowed action for tier ${tier} ${dom}` });
      }
  });

export type BanditConfig = z.infer<typeof Config>;
export const banditConfig: BanditConfig = Config.parse(raw);
