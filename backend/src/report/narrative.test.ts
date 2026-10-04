// The trip summary for friends and family: short, specific to what happened, never a location.
import { test } from "node:test";
import assert from "node:assert/strict";
import { riskConfig as cfg } from "../risk/config.ts";
import { buildCard, type CardWindow } from "../risk/card.ts";
import { initialState, processWindow } from "../risk/decision.ts";
import { observe } from "../risk/expression.ts";
import type { SignalWindow, TripContext } from "../risk/types.ts";
import { tripNarrative } from "./narrative.ts";

const T0 = Date.parse("2026-10-03T20:00:00Z");
const NEUTRAL: SignalWindow = {
  ts: "", face_visible: true, heart_rate: 70, breathing_rate: 15, engagement: 1, eye_closure_frac: 0, longest_eye_closure_s: 0,
  yawns: 0, emotion_stress: 0, gaze_off_road_s: 0, phone_in_hand: false, hard_brakes: 0, swerves: 0, speed_mph: 60, speed_limit_mph: 70,
};
const ctx: TripContext = { kidsInCar: false, lowExperience: false, sleepHours: null, sharingOn: true };

function card(scenario: Partial<SignalWindow>, n: number) {
  let state = initialState();
  const windows: CardWindow[] = [];
  const events: { actions: any[]; override: any }[] = [];
  for (let i = 0; i < n; i++) {
    const w = { ...NEUTRAL, ...(i < cfg.baselineWindows ? {} : scenario), ts: new Date(T0 + i * 10_000).toISOString() };
    const r = processWindow(state, w, ctx, cfg);
    state = r.state;
    windows.push({ ts: w.ts, score: r.evaluation.score, tier: r.evaluation.tier, result: r.evaluation, raw: w });
    if (r.evaluation.actions.some((a) => a !== "none")) events.push({ actions: r.evaluation.actions, override: r.evaluation.override });
  }
  return buildCard(windows, windows.map((w) => observe(w.raw, cfg)), ctx, cfg, { events });
}

test("a clean drive says so and needs no alerts", () => {
  const t = tripNarrative(card({}, 40), "Alex");
  assert.match(t, /^Alex had a smooth, attentive drive\./);
  assert.match(t, /No warnings were needed over 7 min, 6\.\d mi\./);
  assert.ok(t.length < 200);
});

test("it names what stood out: speeding, phone use, hard braking", () => {
  const fast = tripNarrative(card({ speed_mph: 90 }, 60), "Sam");
  assert.match(fast, /^Sam's drive (was risky|had)/);
  assert.match(fast, /Sam was over the limit for \d+ (min|s) \(up to 20 mph over\)/);

  const phone = tripNarrative(card({ phone_in_hand: true }, 60), "Sam");
  assert.match(phone, /Sam used a phone for \d+ (min|s)/);

  const brakes = tripNarrative(card({ hard_brakes: 2, swerves: 1 }, 60), "Sam");
  assert.match(brakes, /hard brakes? and \d+ swerves?/);
});

test("at most two standouts, worst first, and contacts only when they were told", () => {
  const t = tripNarrative(card({ speed_mph: 90, phone_in_hand: true, emotion_stress: 1, heart_rate: 100 }, 60), "Sam");
  assert.ok((t.match(/ and /g) ?? []).length <= 2);
  assert.match(t, /Contacts were told/);
  assert.doesNotMatch(tripNarrative(card({}, 40), "Alex"), /Contacts/);
});

test("a microsleep is called out and contacts are said to be told", () => {
  const t = tripNarrative(card({ longest_eye_closure_s: 2, eye_closure_frac: 0.4, yawns: 1 }, 30), "Jo");
  assert.match(t, /A microsleep triggered an urgent alert and contacts were told\./);
  assert.match(t, /drowsiness/);
});

test("short drives are flagged provisional, and the text never carries a location", () => {
  const short = tripNarrative(card({}, 10), "Alex");
  assert.match(short, /score is provisional/);
  for (const c of [card({ speed_mph: 90 }, 40), card({}, 40), card({ phone_in_hand: true }, 40)]) {
    assert.doesNotMatch(tripNarrative(c, "Alex"), /maps\.|lat|lon|°|street|\bSt\b/i);
  }
});

test("one warning is singular", () => {
  const c = card({}, 40);
  c.metrics.interventions.voice_nudge = 1;
  c.categories.alertness = 60;
  assert.match(tripNarrative(c, "Alex"), /1 voice warning played\./);
});
