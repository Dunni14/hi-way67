import { test } from "node:test";
import assert from "node:assert/strict";
import { ridgeFit, solve } from "./linalg.ts";
import { FEATURES, emptyFeatures } from "./features.ts";
import { DEFAULT_WEIGHTS, multiplier, score } from "./score.ts";
import { fitWeights, nudge } from "./adapt.ts";
import { DecisionTree } from "./tree.ts";
import { RiskEngine } from "./engine.ts";
import { RollingMean, type Sample } from "./signals.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test("solve + ridgeFit recover known weights", () => {
  near(solve([[2, 0], [0, 4]], [2, 8])[1]!, 2);
  const truth = [0.5, 0.2, 0.3];
  const X = Array.from({ length: 40 }, (_, i) => [Math.sin(i), Math.cos(i * 1.7), (i % 5) / 5]);
  const y = X.map((r) => r.reduce((s, v, j) => s + v * truth[j]!, 0));
  ridgeFit(X, y, 1e-9).forEach((w, j) => near(w, truth[j]!, 1e-4));
});

test("multiplier raises stakes only on existing risk", () => {
  near(multiplier({ kidsInCar: false, lowExperience: false }), 1);
  near(multiplier({ kidsInCar: true, lowExperience: true }), 1.4);
  const zero = score(emptyFeatures(), DEFAULT_WEIGHTS, { kidsInCar: true, lowExperience: true });
  assert.equal(zero.R, 0);
  const f = { ...emptyFeatures(), eye_closure: 0.5 };
  const a = score(f, DEFAULT_WEIGHTS, { kidsInCar: false, lowExperience: false });
  const b = score(f, DEFAULT_WEIGHTS, { kidsInCar: true, lowExperience: false });
  near(b.R, a.R * 1.25);
});

test("drowsy vs reckless dominance", () => {
  const ctx = { kidsInCar: false, lowExperience: false };
  const d = score({ ...emptyFeatures(), eye_closure: 1, engagement_loss: 0.8 }, DEFAULT_WEIGHTS, ctx);
  assert.equal(d.dominant, "drowsy");
  const r = score({ ...emptyFeatures(), speed_over_limit: 1, hard_brake_count: 1 }, DEFAULT_WEIGHTS, ctx);
  assert.equal(r.dominant, "reckless");
});

test("losing the face rescales phone-sensor weight instead of zeroing the score", () => {
  const ctx = { kidsInCar: false, lowExperience: false };
  const f = { ...emptyFeatures(), speed_over_limit: 1 };
  const full = score(f, DEFAULT_WEIGHTS, ctx);
  const noFace = score(f, DEFAULT_WEIGHTS, ctx, new Set());
  assert.ok(noFace.reckless > full.reckless);
  assert.ok(noFace.reckless <= full.reckless * 2 + 1e-9);
});

test("nudge: dismissal lowers the dominant weights, confirmation raises them", () => {
  const x = FEATURES.map((k) => (k === "eye_closure" ? 1 : 0));
  const i = FEATURES.indexOf("eye_closure");
  const down = nudge(DEFAULT_WEIGHTS, "drowsy", x, "dismissed");
  const up = nudge(DEFAULT_WEIGHTS, "drowsy", x, "confirmed");
  assert.ok(down.drowsy[i]! < DEFAULT_WEIGHTS.drowsy[i]!);
  assert.ok(up.drowsy[i]! > DEFAULT_WEIGHTS.drowsy[i]!);
  assert.deepEqual(down.reckless, DEFAULT_WEIGHTS.reckless); // other vector untouched
  assert.deepEqual(DEFAULT_WEIGHTS.drowsy[0], 0.15); // input not mutated
});

test("fitWeights clips negatives", () => {
  const X = [[1, 0], [0, 1], [1, 1], [2, 1]];
  const w = fitWeights(X, [0.5, -0.4, 0.1, 0.6], 1e-6);
  assert.ok(w.every((v) => v >= 0));
});

test("RollingMean ignores one missing frame but reports missing when mostly absent", () => {
  const m = new RollingMean(10);
  for (let i = 0; i < 9; i++) m.push(10);
  m.push(undefined);
  near(m.value!, 10);
  for (let i = 0; i < 6; i++) m.push(undefined);
  assert.equal(m.value, undefined);
});

const tick = (tree: DecisionTree, ts: number, R: number, o: Partial<Parameters<DecisionTree["step"]>[0]> = {}) =>
  tree.step({ ts, R, drowsy: R, reckless: 0, kidsInCar: false, sharing: "high_only", ...o });

test("tree: R < 40 does nothing; alert must hold 15 s", () => {
  const t = new DecisionTree();
  assert.equal(tick(t, 0, 30), null);
  assert.equal(tick(t, 10_000, 45), null); // just crossed
  assert.equal(tick(t, 20_000, 45), null); // held only 10 s
  assert.equal(tick(t, 25_000, 45)?.tier, 40);
});

test("tree: flicker resets the hold", () => {
  const t = new DecisionTree();
  tick(t, 0, 50);
  tick(t, 10_000, 30); // dipped
  assert.equal(tick(t, 20_000, 50), null);
  assert.equal(tick(t, 40_000, 50)?.tier, 40);
});

test("tree: tiers, voice, rest stop, notify", () => {
  const t = new DecisionTree();
  tick(t, 0, 75);
  const d = tick(t, 15_000, 75)!;
  assert.equal(d.tier, 70);
  assert.equal(d.voice, "warning");
  assert.equal(d.routeRestStop, true);
  assert.equal(d.notify, "none");

  const t2 = new DecisionTree();
  tick(t2, 0, 90, { drowsy: 0, reckless: 90, sharing: "never" });
  const e = tick(t2, 15_000, 90, { drowsy: 0, reckless: 90, sharing: "never" })!;
  assert.equal(e.tier, 85);
  assert.equal(e.dominant, "reckless");
  assert.equal(e.notify, "ask");
  assert.equal(e.routeRestStop, false);
});

test("tree: kids in car bumps 70 to 85", () => {
  const t = new DecisionTree();
  tick(t, 0, 75, { kidsInCar: true });
  assert.equal(tick(t, 15_000, 75, { kidsInCar: true })?.tier, 85);
});

test("tree: 70+ sustained for 2 minutes becomes 85", () => {
  const t = new DecisionTree();
  let last = null;
  for (let s = 0; s <= 120; s += 5) last = tick(t, s * 1000, 75) ?? last;
  assert.equal(last?.tier, 85);
});

test("tree: cooldown suppresses same/lower tier, allows escalation", () => {
  const t = new DecisionTree();
  tick(t, 0, 50);
  assert.equal(tick(t, 15_000, 50)?.tier, 40);
  assert.equal(tick(t, 40_000, 50), null); // cooldown
  assert.equal(tick(t, 140_000, 50)?.tier, 40); // elapsed
  tick(t, 150_000, 90);
  assert.equal(tick(t, 165_000, 90)?.tier, 85); // escalation ignores lower-tier cooldown
  assert.equal(tick(t, 200_000, 90), null);
});

test("tree: 'I'm fine' backs off non-urgent tiers but never the emergency tier", () => {
  const t = new DecisionTree();
  t.dismiss(0);
  tick(t, 0, 50);
  assert.equal(tick(t, 20_000, 50), null);
  tick(t, 30_000, 90);
  assert.equal(tick(t, 45_000, 90)?.tier, 85);
});

// ---- end to end ------------------------------------------------------------

const alert = (ts: number): Sample => ({ ts, hr: 72, breathing: 15, engagement: 0.9, eyeClosure: 0.02, stress: 0.05, speed: 60, speedLimit: 65 });
const drowsy = (ts: number): Sample => ({ ts, hr: 56, breathing: 9, engagement: 0.3, eyeClosure: 0.45, stress: 0.05, yawn: ts % 3000 === 0, speed: 60, speedLimit: 65 });

function run(engine: RiskEngine, from: number, seconds: number, make: (ts: number) => Sample) {
  const out = [];
  for (let s = 0; s < seconds; s++) {
    const o = engine.push(make(from + s * 1000));
    if (o) out.push(o);
  }
  return out;
}

test("engine: alert driver stays low, then faked drowsiness climbs and fires", () => {
  const e = new RiskEngine();
  const calm = run(e, 1_700_000_000_000, 90, alert);
  assert.ok(calm.every((o) => o.window.R < 40 && o.decision === null));
  assert.equal(calm.at(-1)!.window.calibrating, false);

  const sleepy = run(e, 1_700_000_090_000, 60, drowsy);
  const fired = sleepy.filter((o) => o.decision);
  assert.ok(fired.length >= 1, "expected a decision");
  assert.equal(fired[0]!.decision!.dominant, "drowsy");
  assert.ok(sleepy.at(-1)!.window.R >= 70);
});

test("engine: kids in car raises R; 'I'm fine' lowers later scores", () => {
  const a = new RiskEngine();
  const b = new RiskEngine();
  b.context = { kidsInCar: true, lowExperience: false };
  run(a, 0, 70, alert);
  run(b, 0, 70, alert);
  const mild = (ts: number): Sample => ({ ts, hr: 68, breathing: 13, engagement: 0.7, eyeClosure: 0.12, stress: 0.05, speed: 60, speedLimit: 65 });
  const ra = run(a, 70_000, 30, mild).at(-1)!.window.R;
  const rb = run(b, 70_000, 30, mild).at(-1)!.window.R;
  assert.ok(ra > 5 && rb < 100, `ra=${ra} rb=${rb}`);
  assert.ok(rb > ra);

  a.feedback("dismissed", 100_000);
  const after = run(a, 100_000, 10, mild).at(-1)!.window.R;
  assert.ok(after < ra);
});

test("engine: face lost mid-trip falls back to phone sensors, no crash, no zeroing", () => {
  const e = new RiskEngine();
  run(e, 0, 70, alert);
  const noFace = (ts: number): Sample => ({ ts, speed: 90, speedLimit: 65, hardBrake: ts % 5000 === 0, swerve: ts % 7000 === 0 });
  const out = run(e, 70_000, 30, noFace);
  assert.equal(out.at(-1)!.window.faceVisible, false);
  assert.ok(out.at(-1)!.window.R > 40);
  assert.equal(out.at(-1)!.window.dominant, "reckless");
});
