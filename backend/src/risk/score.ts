// Spec §5: logistic-form risk. z = Σ w_i·x_i, capped at ln(oddsCap), scaled to 0..100.
import type { RiskConfig } from "./config.ts";
import { FACTORS, type Factor, type Levels, type WeightMults } from "./types.ts";

export const defaultMults = (): WeightMults => ({ agitated: 1, speeding: 1, drowsy: 1, phone: 1, distracted: 1, erratic: 1 });

/** Added to z only when sleep_hours is known. Buckets are [lo, hi). */
export function sleepTerm(hours: number | null | undefined, cfg: RiskConfig): number {
  if (hours == null) return 0;
  const bucket = [...cfg.sleep].sort((a, b) => a.underHours - b.underHours).find((b) => hours < b.underHours);
  return bucket?.add ?? 0;
}

export const contributions = (levels: Levels, cfg: RiskConfig, mults: WeightMults = defaultMults()): Record<Factor, number> =>
  Object.fromEntries(FACTORS.map((f) => [f, cfg.factors[f] * mults[f] * levels[f]])) as Record<Factor, number>;

export type ScoreInput = { levels: Levels; kidsInCar: boolean; lowExperience: boolean; sleepHours: number | null; mults?: WeightMults };

export function scoreOf(i: ScoreInput, cfg: RiskConfig) {
  const c = contributions(i.levels, cfg, i.mults);
  const sleep = sleepTerm(i.sleepHours, cfg);
  const zRaw = FACTORS.reduce((s, f) => s + c[f], 0) + sleep;
  const lnCap = Math.log(cfg.oddsCap);
  const z = Math.min(zRaw, lnCap);
  const rBase = (100 * z) / lnCap;
  const m = 1 + cfg.context.kids_in_car * Number(i.kidsInCar) + cfg.context.low_experience * Number(i.lowExperience);
  const R = Math.min(100, rBase * m);

  const zDrowsy = c.drowsy + sleep;
  const zReckless = c.agitated + c.speeding + c.phone + c.distracted + c.erratic;
  return { score: R, zDrowsy, zReckless, dominant: (zDrowsy >= zReckless ? "drowsy" : "reckless") as "drowsy" | "reckless" };
}

/** The single factor contributing most to z (used to aim per-driver feedback). */
export function dominantFactor(levels: Levels, cfg: RiskConfig, mults?: WeightMults): Factor {
  const c = contributions(levels, cfg, mults);
  return FACTORS.reduce((best, f) => (c[f] > c[best] ? f : best), FACTORS[0]);
}
