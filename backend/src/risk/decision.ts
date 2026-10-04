// Spec §3 + §6: baseline, smoothing, scoring and the decision tree for one window.
// `processWindow` is pure: state in, state out, no I/O and no clock (the window's
// own `ts` is the clock).
import type { RiskConfig } from "./config.ts";
import { computeLevels } from "./levels.ts";
import { defaultMults, scoreOf } from "./score.ts";
import { baselineOf, smooth, type Baseline } from "./smoothing.ts";
import type { Action, Evaluation, Levels, Override, SignalWindow, Tier, TripContext, WeightMults } from "./types.ts";

export type EngineState = {
  /** Last `smoothingWindows` raw windows. */
  recent: SignalWindow[];
  /** Windows seen so far this trip. */
  count: number;
  baseline: Baseline | null;
  /** Raw windows collected while the baseline is being set. */
  baselineAcc: SignalWindow[];
  /** Raw score tier of the previous scored window (for the 2-window hold). */
  prevRawTier: Tier;
  drowsyStreak: number;
  tier2Streak: number;
  faceHiddenStreak: number;
  /** Epoch ms of the last voice action per tier. */
  lastVoiceMs: Partial<Record<1 | 2 | 3, number>>;
  lastNotifyMs: number | null;
};

export const initialState = (): EngineState => ({
  recent: [],
  count: 0,
  baseline: null,
  baselineAcc: [],
  prevRawTier: 0,
  drowsyStreak: 0,
  tier2Streak: 0,
  faceHiddenStreak: 0,
  lastVoiceMs: {},
  lastNotifyMs: null,
});

const ZERO_LEVELS: Levels = { drowsy: 0, agitated: 0, speeding: 0, phone: 0, distracted: 0, erratic: 0 };
const VOICE = { 1: "voice_nudge", 2: "voice_warning", 3: "voice_urgent" } as const;

const tierOfScore = (R: number, cfg: RiskConfig): Tier =>
  R >= cfg.tiers.urgent ? 3 : R >= cfg.tiers.warning ? 2 : R >= cfg.tiers.nudge ? 1 : 0;

export function processWindow(
  prev: EngineState,
  w: SignalWindow,
  ctx: TripContext,
  cfg: RiskConfig,
  mults: WeightMults = defaultMults(),
  /** Score needed to text contacts below tier 3 (or above it, to hold back tier 3 without an override). Defaults to the urgent tier. */
  notifyThreshold: number = cfg.tiers.urgent,
): { evaluation: Evaluation; state: EngineState } {
  const s = structuredClone(prev);
  const nowMs = Date.parse(w.ts);
  s.recent = [...s.recent, w].slice(-cfg.smoothingWindows);
  s.count += 1;

  // Face visibility: 3 hidden windows in a row -> degraded (speed and motion only).
  s.faceHiddenStreak = w.face_visible === false ? s.faceHiddenStreak + 1 : 0;
  const degraded = s.faceHiddenStreak >= cfg.degradedAfterWindows;

  // Baseline: the first N windows only establish the driver's resting HR and breathing.
  if (s.count <= cfg.baselineWindows) {
    s.baselineAcc.push(w);
    if (s.count === cfg.baselineWindows) s.baseline = baselineOf(s.baselineAcc);
    return { evaluation: quiet(degraded), state: s };
  }
  const baseline = s.baseline ?? { heartRate: null, breathingRate: null };

  const levels = computeLevels(smooth(s.recent), baseline, cfg, { faceless: degraded });
  const sc = scoreOf(
    { levels, kidsInCar: ctx.kidsInCar, lowExperience: ctx.lowExperience, sleepHours: degraded ? null : ctx.sleepHours, mults },
    cfg,
  );

  // Score tier must hold for `holdWindows` consecutive windows to count.
  const rawTier = tierOfScore(sc.score, cfg);
  let tier: Tier = Math.min(rawTier, s.prevRawTier) as Tier;
  if (cfg.holdWindows <= 1) tier = rawTier;
  s.prevRawTier = rawTier;

  // Overrides (a sleeping driver must alert even though drowsiness alone scores low).
  let override: Override | null = null;
  const O = cfg.overrides;
  s.drowsyStreak = levels.drowsy >= O.drowsyLevel ? s.drowsyStreak + 1 : 0;
  const microsleep = (w.longest_eye_closure_s ?? 0) >= O.microsleepS && !degraded;
  if (microsleep) {
    tier = 3;
    override = "microsleep";
  } else {
    if (s.drowsyStreak >= O.drowsyFloorWindows && tier < 2) {
      tier = 2;
      override = "drowsy_sustained_3";
    }
    if (s.drowsyStreak >= O.drowsyUrgentWindows) {
      tier = 3;
      override = "drowsy_sustained_12";
    }
    s.tier2Streak = tier === 2 ? s.tier2Streak + 1 : 0;
    if (s.tier2Streak >= O.tier2UrgentWindows) {
      tier = 3;
      override = "tier2_sustained_12";
    }
  }
  if (microsleep) s.tier2Streak = 0;

  // Kids in the car raise any active tier by one.
  if (ctx.kidsInCar && tier >= 1) tier = Math.min(3, tier + 1) as Tier;

  const actions = actionsFor(tier, s, nowMs, ctx, cfg, { score: sc.score, override, threshold: notifyThreshold });
  return {
    evaluation: { score: round1(sc.score), tier, dominant: sc.dominant, actions, levels, override, degraded },
    state: s,
  };
}

type NotifyGate = { score: number; override: Override | null; threshold: number };

/**
 * Tier 3 notifies when an override or the kids rule raised it, or its score reaches the threshold
 * (so a careful driver's higher threshold holds back a plain score-driven tier 3). Tier 2 notifies
 * only when the threshold was lowered below the urgent tier and the score reaches it.
 */
const wantsNotify = (tier: Tier, ctx: TripContext, cfg: RiskConfig, g: NotifyGate) =>
  tier === 3 ? g.override != null || ctx.kidsInCar || g.score >= g.threshold : tier === 2 && g.threshold < cfg.tiers.urgent && g.score >= g.threshold;

function actionsFor(tier: Tier, s: EngineState, nowMs: number, ctx: TripContext, cfg: RiskConfig, gate: NotifyGate): Action[] {
  if (tier === 0) return ["none"];
  const out: Action[] = [];
  const last = s.lastVoiceMs[tier];
  if (last == null || nowMs - last >= cfg.cooldownS * 1000) {
    out.push(VOICE[tier]);
    s.lastVoiceMs[tier] = nowMs;
  }
  if (wantsNotify(tier, ctx, cfg, gate) && (s.lastNotifyMs == null || nowMs - s.lastNotifyMs >= cfg.notifyCooldownS * 1000)) {
    out.push(ctx.sharingOn ? "notify_contacts" : "ask_permission_to_notify");
    s.lastNotifyMs = nowMs;
  }
  return out.length ? out : ["none"];
}

const quiet = (degraded: boolean): Evaluation => ({
  score: 0,
  tier: 0,
  dominant: "drowsy",
  actions: ["none"],
  levels: { ...ZERO_LEVELS },
  override: null,
  degraded,
});

const round1 = (n: number) => Math.round(n * 10) / 10;
