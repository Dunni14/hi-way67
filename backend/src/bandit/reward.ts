// Reward, context and allowed-action rules for one intervention. Pure.
import type { BanditConfig } from "./config.ts";
import type { Levels } from "../risk/types.ts";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mean = (v: number[]) => v.reduce((s, n) => s + n, 0) / v.length;

export type Dominant = "drowsy" | "reckless";

/** The level the intervention is trying to bring down. */
export const targetLevel = (dominant: Dominant, l: Levels) => (dominant === "drowsy" ? l.drowsy : Math.max(l.agitated, l.speeding));

export type RewardInput = {
  /** Target level over the windows just before the intervention, and over the last windows of the reward period. */
  before: number[];
  after: number[];
  stoppedAfterDrowsy: boolean;
  falseAlarm: boolean;
  tierWentUp: boolean;
};

/** r = clamp((before - after) / scale, -1, 1), plus adjustments, clamped to [rewardMin, rewardMax]. Null when there is nothing to compare. */
export function computeReward(i: RewardInput, cfg: BanditConfig): number | null {
  if (!i.before.length || !i.after.length) return null;
  let r = clamp((mean(i.before) - mean(i.after)) / cfg.rewardScale, -1, 1);
  if (i.stoppedAfterDrowsy) r += cfg.adjustments.stopped;
  if (i.falseAlarm) r += cfg.adjustments.falseAlarm;
  if (i.tierWentUp) r += cfg.adjustments.tierUp;
  return clamp(r, cfg.rewardMin, cfg.rewardMax);
}

export type ContextInput = { levels: Levels; tripMinutes: number; ts: Date; kidsInCar: boolean; interventionsThisTrip: number };

/** d = 8, all 0..1: bias, drowsy, agitated, speeding, trip length, night, kids, interventions so far. */
export function buildContext(i: ContextInput, cfg: BanditConfig): number[] {
  const { nightStartHour: from, nightEndHour: to } = cfg.context;
  const h = i.ts.getHours(); // server local time
  const night = h >= from || h < to;
  return [
    1,
    i.levels.drowsy,
    i.levels.agitated,
    i.levels.speeding,
    clamp(i.tripMinutes / cfg.context.tripMinutesFull, 0, 1), // window ts can precede trip start (client clock skew)
    night ? 1 : 0,
    i.kidsInCar ? 1 : 0,
    clamp(i.interventionsThisTrip / cfg.context.interventionsFull, 0, 1),
  ];
}

/** Actions the bandit may pick for this tier and dominant state. */
export function allowedActions(cfg: BanditConfig, tier: 1 | 2, dominant: Dominant, familyVoice: boolean): string[] {
  return Object.entries(cfg.actions)
    .filter(([, a]) => a.tiers.includes(tier) && (a.dominant === "both" || a.dominant === dominant) && (!a.requiresFamilyVoice || familyVoice))
    .map(([id]) => id);
}
