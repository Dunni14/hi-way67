// Report card formula, profile adaptation and the notify threshold, in-process (no Postgres).
import { test } from "node:test";
import assert from "node:assert/strict";
// These tests check the engine logic against the 6-window (60 s) baseline they were written for;
// the live config (weights.json baselineWindows) may calibrate faster.
import { riskConfig } from "./config.ts";
const cfg = { ...riskConfig, baselineWindows: 6 };
import { buildCard, letterOf, type CardWindow } from "./card.ts";
import { observe } from "./expression.ts";
import { initialState, processWindow } from "./decision.ts";
import { applyCard, applyFeedback, initialProfile, notifyThreshold } from "./profile.ts";
import type { SignalWindow, TripContext } from "./types.ts";

const T0 = Date.parse("2026-10-03T20:00:00Z");
const NEUTRAL: SignalWindow = {
  ts: "", face_visible: true, heart_rate: 70, breathing_rate: 15, engagement: 1, eye_closure_frac: 0, longest_eye_closure_s: 0,
  yawns: 0, emotion_stress: 0, gaze_off_road_s: 0, phone_in_hand: false, hard_brakes: 0, swerves: 0, speed_mph: 60, speed_limit_mph: 70,
};
const ctx: TripContext = { kidsInCar: false, lowExperience: false, sleepHours: null, sharingOn: true };

function run(scenario: Partial<SignalWindow>, n: number, threshold?: number, c: TripContext = ctx) {
  let state = initialState();
  const windows: CardWindow[] = [];
  const notified: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const w = { ...NEUTRAL, ...(i < cfg.baselineWindows ? {} : scenario), ts: new Date(T0 + i * 10_000).toISOString() };
    const r = processWindow(state, w, c, cfg, undefined, threshold);
    state = r.state;
    windows.push({ ts: w.ts, score: r.evaluation.score, tier: r.evaluation.tier, result: r.evaluation, raw: w });
    notified.push(r.evaluation.actions.includes("notify_contacts"));
  }
  return { windows, notified, obs: windows.map((w) => observe(w.raw as SignalWindow, cfg)) };
}

test("expression labels follow the priority order", () => {
  const e = (o: Partial<SignalWindow>) => observe({ ...NEUTRAL, ...o }, cfg).expression;
  assert.equal(e({}), "calm");
  assert.equal(e({ engagement: 0.3 }), "neutral");
  assert.equal(e({ emotion_stress: 0.8 }), "stressed");
  assert.equal(e({ phone_in_hand: true }), "distracted");
  assert.equal(e({ eye_closure_frac: 0.2, emotion_stress: 0.9 }), "drowsy");
  assert.equal(e({ face_visible: false, eye_closure_frac: 0.5 }), "no_face");
});

test("a clean trip scores 100 / A, a reckless one scores far lower", () => {
  const clean = run({}, 40);
  const good = buildCard(clean.windows, clean.obs, ctx, cfg);
  assert.equal(good.score, 100);
  assert.equal(good.grade, "A");
  assert.equal(good.expression.dominant, "calm");
  assert.equal(good.features.length, good.feature_names.length);

  const bad = run({ speed_mph: 95, phone_in_hand: true, emotion_stress: 1, heart_rate: 100 }, 40);
  const card = buildCard(bad.windows, bad.obs, ctx, cfg);
  assert.ok(card.score < 40, `score ${card.score}`);
  assert.ok(card.categories.speed < 60 && card.categories.attention < 60 && card.categories.composure < 60);
  assert.equal(card.counts.phone_windows, 34);
});

test("formula: penalty is the documented weighted sum", () => {
  const { windows, obs } = run({ speed_mph: 95, phone_in_hand: true, emotion_stress: 1, heart_rate: 100 }, 40);
  const c = buildCard(windows, obs, ctx, cfg);
  const P = cfg.report.penalty;
  const expected =
    P.meanRisk * c.components.mean_risk + P.p90Risk * c.components.p90_risk + P.tier2Frac * c.components.tier2_frac +
    P.tier3Frac * c.components.tier3_frac + P.microsleep * Math.min(c.components.microsleeps, P.microsleepCap);
  assert.ok(Math.abs(c.components.penalty - expected) < 0.6);
  assert.equal(c.score, Math.max(0, Math.round((100 - c.components.penalty) * 10) / 10));
});

test("short trips are provisional with low confidence; letters follow the cut-offs", () => {
  const { windows, obs } = run({}, 10);
  const c = buildCard(windows, obs, ctx, cfg);
  assert.equal(c.provisional, true);
  assert.ok(c.confidence < 0.1);
  assert.deepEqual([95, 85, 70, 55, 10].map((s) => letterOf(s, cfg)), ["A", "B", "C", "D", "F"]);
});

test("careless history lowers the notify threshold, careful history raises it, provisional cards are ignored", () => {
  const bad = run({ speed_mph: 95, phone_in_hand: true, emotion_stress: 1, heart_rate: 100 }, 80);
  const good = run({}, 80);
  const badCard = buildCard(bad.windows, bad.obs, ctx, cfg);
  const goodCard = buildCard(good.windows, good.obs, ctx, cfg);

  let careless = initialProfile(cfg);
  let careful = initialProfile(cfg);
  assert.equal(notifyThreshold(careless, cfg), cfg.tiers.urgent - 0); // neutral care keeps the default of 85
  for (let i = 0; i < 6; i++) {
    careless = applyCard(careless, badCard, cfg);
    careful = applyCard(careful, goodCard, cfg);
  }
  assert.ok(notifyThreshold(careless, cfg) < 85 && notifyThreshold(careless, cfg) >= cfg.adaptive.minNotify);
  assert.ok(notifyThreshold(careful, cfg) > 85 && notifyThreshold(careful, cfg) <= cfg.adaptive.maxNotify);

  const prov = buildCard(run({}, 10).windows, [], ctx, cfg);
  assert.deepEqual(applyCard(initialProfile(cfg), prov, cfg), initialProfile(cfg));
});

test("feedback shifts the threshold within its clamp", () => {
  let p = initialProfile(cfg);
  for (let i = 0; i < 30; i++) p = applyFeedback(p, "false_alarm", cfg);
  assert.equal(p.learnedShift, cfg.adaptive.learnedClamp);
  for (let i = 0; i < 60; i++) p = applyFeedback(p, "confirmed", cfg);
  assert.equal(p.learnedShift, -cfg.adaptive.learnedClamp);
});

test("a lower threshold texts a friend at tier 2, a higher one holds back a plain tier 3, overrides always notify", () => {
  const sc = { speed_mph: 95, phone_in_hand: true, emotion_stress: 1, heart_rate: 100 };
  const base = run(sc, 30);
  const maxScore = Math.max(...base.windows.map((w) => w.score));
  assert.ok(maxScore >= 85, `scenario must reach tier 3, got ${maxScore}`);
  assert.ok(base.notified.some(Boolean));
  assert.ok(run(sc, 30, 95).windows.some((w) => w.tier === 3) && !run(sc, 30, 101).notified.some(Boolean));

  const mid = { speed_mph: 75, emotion_stress: 1, heart_rate: 100 };
  // 10 scored windows: long enough for tier 2, short of the 12-window tier 2 -> tier 3 override
  const tier2 = run(mid, 16);
  assert.ok(tier2.windows.some((w) => w.tier === 2) && !tier2.windows.some((w) => w.tier === 3));
  assert.ok(!tier2.notified.some(Boolean));
  assert.ok(run(mid, 16, 60).notified.some(Boolean));

  const micro = run({ longest_eye_closure_s: 2 }, 12, 101);
  assert.ok(micro.notified.some(Boolean));
});

test("card metrics: distance, time over the limit, tier seconds, interventions, series", () => {
  const { windows, obs } = run({ speed_mph: 95, phone_in_hand: true, emotion_stress: 1, heart_rate: 100, yawns: 1 }, 40);
  const events = windows.filter((w) => w.result.actions.some((a) => a !== "none")).map((w) => ({ actions: w.result.actions, override: w.result.override }));
  const c = buildCard(windows, obs, ctx, cfg, { events, baselineHr: 70, sharingMode: "always", feedback: { confirmed: 1, false_alarm: 2 } });
  const m = c.metrics;
  assert.equal(m.duration_s, 400);
  assert.equal(m.over_limit_s, 340); // 34 scored windows at 95 in a 70 zone
  assert.equal(m.max_over_limit_mph, 25);
  assert.equal(m.max_speed_mph, 95);
  assert.equal(m.phone_s, 340);
  assert.equal(m.yawns, 34);
  assert.equal(m.tier_seconds.reduce((a, b) => a + b, 0), 340);
  assert.ok(m.interventions.voice_urgent >= 1 && m.interventions.notify_contacts === 1);
  assert.ok(m.hr_above_baseline_peak != null && m.hr_above_baseline_peak >= 20);
  assert.deepEqual(m.feedback, { confirmed: 1, false_alarm: 2 });
  assert.equal(c.sharing_mode, "always");
  assert.ok(c.series.length >= 13 && c.series.length <= 14, `series ${c.series.length}`);
  assert.ok(c.series.every((p, i, a) => i === 0 || p.ts > a[i - 1]!.ts));
  assert.equal(m.max_tier, 3);
});
