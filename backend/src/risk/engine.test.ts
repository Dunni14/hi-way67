// Spec §10 test table, against the pure core (no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { riskConfig as cfg } from "./config.ts";
import { initialState, processWindow, type EngineState } from "./decision.ts";
import { defaultMults } from "./score.ts";
import type { Evaluation, SignalWindow, TripContext } from "./types.ts";

const T0 = Date.parse("2026-10-03T20:00:00Z");
const NEUTRAL: Omit<SignalWindow, "ts"> = {
  face_visible: true, heart_rate: 70, breathing_rate: 15, engagement: 1, eye_closure_frac: 0,
  longest_eye_closure_s: 0, yawns: 0, emotion_stress: 0, gaze_off_road_s: 0, phone_in_hand: false,
  hard_brakes: 0, swerves: 0, speed_mph: 60, speed_limit_mph: 70,
};
const ctx0: TripContext = { kidsInCar: false, lowExperience: false, sleepHours: null, sharingOn: true };

const win = (i: number, o: Partial<SignalWindow> = {}): SignalWindow => ({ ...NEUTRAL, ts: new Date(T0 + i * 10_000).toISOString(), ...o });

/** 6 baseline windows, then `n` scenario windows. `base` lets a scenario pre-set non-baseline signals so smoothing starts steady. */
function run(scenario: Partial<SignalWindow>, n = 8, ctx = ctx0, base: Partial<SignalWindow> = {}) {
  let st: EngineState = initialState();
  const out: Evaluation[] = [];
  for (let i = 0; i < 6 + n; i++) {
    const r = processWindow(st, win(i, i < 6 ? { ...scenario, ...base, heart_rate: 70, breathing_rate: 15 } : scenario), ctx, cfg);
    st = r.state;
    out.push(r.evaluation);
  }
  return out;
}
const last = (xs: Evaluation[]) => xs[xs.length - 1]!;

const DROWSY = { eye_closure_frac: 0.3, yawns: 3, engagement: 0, breathing_rate: 11 };
const AGITATED = { emotion_stress: 1, heart_rate: 95 };
const SPEEDING = { speed_mph: 90, speed_limit_mph: 70 };

test("baseline windows return tier 0", () => {
  assert.ok(run(SPEEDING, 0).every((e) => e.tier === 0 && e.score === 0));
});

test("all neutral: score 0, tier 0", () => {
  const e = last(run({}));
  assert.equal(e.score, 0);
  assert.equal(e.tier, 0);
});

test("drowsy only: ~31.2, tier 0 by score; override 2 -> tier 2 on 3rd scored window", () => {
  const out = run(DROWSY, 8, ctx0, { eye_closure_frac: 0.3, yawns: 3, engagement: 0 }).slice(6);
  assert.ok(Math.abs(last(out).score - 31.2) < 0.1);
  assert.deepEqual(out.slice(0, 3).map((e) => e.tier), [0, 0, 2]);
  assert.equal(out[2]!.override, "drowsy_sustained_3");
  assert.ok(out[2]!.actions.includes("voice_warning"));
});

test("agitated only: ~58.3, tier 1", () => {
  const e = last(run(AGITATED));
  assert.ok(Math.abs(e.score - 58.3) < 0.1, String(e.score));
  assert.equal(e.tier, 1);
});

test("speeding only: ~65.2, tier 1", () => {
  const e = last(run(SPEEDING));
  assert.ok(Math.abs(e.score - 65.2) < 0.1, String(e.score));
  assert.equal(e.tier, 1);
});

test("drowsy + phone: ~63.9, tier 1", () => {
  // 2nd scored window: hold satisfied, sustained-drowsy override (3 windows) not yet.
  const out = run({ ...DROWSY, phone_in_hand: true }, 8, ctx0, { eye_closure_frac: 0.3, yawns: 3, engagement: 0 });
  assert.ok(Math.abs(last(out).score - 63.9) < 0.1, String(last(out).score)); // steady state
  assert.equal(out[7]!.tier, 1);
});

test("agitated + speeding 0.5: ~90.9, tier 3", () => {
  const e = last(run({ ...AGITATED, speed_mph: 80, speed_limit_mph: 70 }));
  assert.ok(Math.abs(e.score - 90.9) < 0.1, String(e.score));
  assert.equal(e.tier, 3);
});

test("agitated + speeding 1.0: z capped, score 100, tier 3", () => {
  const e = last(run({ ...AGITATED, ...SPEEDING }));
  assert.equal(e.score, 100);
  assert.equal(e.tier, 3);
});

test("longest_eye_closure_s = 2.0 -> tier 3 on that window, no hold", () => {
  const out = run({ longest_eye_closure_s: 2 }, 1);
  const e = last(out);
  assert.equal(e.tier, 3);
  assert.equal(e.override, "microsleep");
  assert.ok(e.actions.includes("notify_contacts"));
});

test("agitated + kids: ~67.0, tier 1 raised to 2", () => {
  const e = last(run(AGITATED, 8, { ...ctx0, kidsInCar: true }));
  assert.ok(Math.abs(e.score - 67.0) < 0.1, String(e.score));
  assert.equal(e.tier, 2);
});

test("same tier twice within 120 s: second has no voice action", () => {
  const out = run(AGITATED, 8).slice(6);
  const voice = out.filter((e) => e.actions.some((a) => a.startsWith("voice_")));
  assert.equal(voice.length, 1);
  // after 120 s it may speak again
  const long = run(AGITATED, 20).slice(6).filter((e) => e.actions.includes("voice_nudge"));
  assert.equal(long.length, 2);
});

test("2-window hold: a single spike never fires", () => {
  let st = initialState();
  let fired = false;
  for (let i = 0; i < 12; i++) {
    const spike = i === 8;
    const r = processWindow(st, win(i, spike ? { ...AGITATED, ...SPEEDING, emotion_stress: 1 } : {}), ctx0, cfg);
    st = r.state;
    fired ||= r.evaluation.tier >= 1 && !r.evaluation.override && r.evaluation.actions[0] !== "none" && i === 8;
  }
  assert.equal(fired, false);
});

test("null fields contribute nothing and don't crash", () => {
  const nulls = Object.fromEntries(Object.keys(NEUTRAL).map((k) => [k, null]));
  const e = last(run(nulls as Partial<SignalWindow>));
  assert.equal(e.score, 0);
  assert.equal(e.tier, 0);
});

test("face hidden for 3 windows: degraded, scores only speed and motion", () => {
  const e = last(run({ face_visible: false, ...AGITATED, ...DROWSY, ...SPEEDING }, 6));
  assert.equal(e.degraded, true);
  assert.equal(e.levels.agitated, 0);
  assert.equal(e.levels.drowsy, 0);
  assert.ok(e.levels.speeding > 0);
});

test("drowsy >= 0.6 for 12 windows -> tier 3", () => {
  const out = run(DROWSY, 14, ctx0, { eye_closure_frac: 0.3, yawns: 3, engagement: 0 }).slice(6);
  assert.equal(out[11]!.tier, 3);
  assert.equal(out[11]!.override, "drowsy_sustained_12");
  assert.ok(out[10]!.tier < 3);
});

test("tier 2 held for 12 windows -> tier 3 (kids off)", () => {
  // score ~ mid 70s: agitated + a little speeding
  const out = run({ ...AGITATED, speed_mph: 75, speed_limit_mph: 70 }, 20).slice(6);
  const idx2 = out.findIndex((e) => e.tier === 2);
  assert.ok(idx2 >= 0, "reaches tier 2");
  const t3 = out.findIndex((e) => e.override === "tier2_sustained_12");
  assert.equal(t3, idx2 + 11);
});

test("notify_contacts at most once per 10 min; sharing off asks permission instead", () => {
  const out = run({ ...AGITATED, ...SPEEDING }, 70).slice(6);
  assert.equal(out.filter((e) => e.actions.includes("notify_contacts")).length, 2); // windows 2 and ~62
  const off = run({ ...AGITATED, ...SPEEDING }, 8, { ...ctx0, sharingOn: false }).slice(6);
  assert.ok(off.some((e) => e.actions.includes("ask_permission_to_notify")));
  assert.ok(!off.some((e) => e.actions.includes("notify_contacts")));
});

test("sleep term only applies when sleep_hours is set", () => {
  assert.equal(last(run({}, 4, { ...ctx0, sleepHours: 8 })).score, 0);
  const tired = last(run({}, 4, { ...ctx0, sleepHours: 3 }));
  assert.ok(Math.abs(tired.score - 62.4) < 0.1, String(tired.score)); // 100·2.44/ln50
});

test("per-driver weight multiplier changes the score", () => {
  const final = (m: ReturnType<typeof defaultMults>) => {
    let st = initialState();
    let score = 0;
    for (let i = 0; i < 10; i++) {
      const r = processWindow(st, win(i, SPEEDING), ctx0, cfg, m);
      st = r.state;
      score = r.evaluation.score;
    }
    return score;
  };
  assert.ok(final({ ...defaultMults(), speeding: 0.5 }) < final(defaultMults()));
});
