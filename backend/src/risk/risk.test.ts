import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, matMul } from "./linalg.ts";
import { FEATURE_NAMES, N_FEATURES, normalize, toVector } from "./features.ts";
import { DEFAULT_WEIGHTS, score, type Context } from "./model.ts";
import { fitWeights, leastSquares } from "./fit.ts";
import { adapt } from "./adapt.ts";
import { RiskEngine } from "./engine.ts";

const none: Context = { kidsInCar: false, lowExperience: false };
const vec = (o: Record<string, number>) => toVector(o);
const T0 = 1_000_000;

test("solve handles a 2x2 system and flags singular matrices", () => {
  assert.deepEqual(solve([[2, 0], [0, 4]], [2, 8]), [1, 2]);
  assert.equal(solve([[1, 2], [2, 4]], [1, 2]), null);
  assert.deepEqual(matMul([[1, 2]], [[3], [4]]), [[11]]);
});

test("normalize clamps to 0..1 and inverts engagement", () => {
  const f = normalize({ breathingRate: 5, heartRate: 200, engagement: 0.2, hardBrakes: 9, speedMph: 90, speedLimitMph: 65, hourOfDay: 2, hoursDriving: 12 });
  for (const n of FEATURE_NAMES) assert.ok(f[n] >= 0 && f[n] <= 1, n);
  assert.equal(f.engagement, 0.8);
  assert.equal(f.night_time, 1);
  assert.equal(f.hard_brake_count, 1);
});

test("context multiplies risk but adds none", () => {
  const zero = vec({});
  assert.equal(score(zero, DEFAULT_WEIGHTS, { kidsInCar: true, lowExperience: true }).R, 0);
  const x = vec({ eye_closure: 0.6, engagement: 0.5 });
  const a = score(x, DEFAULT_WEIGHTS, none);
  const b = score(x, DEFAULT_WEIGHTS, { kidsInCar: true, lowExperience: false });
  assert.ok(Math.abs(b.R - a.R * 1.25) < 1e-9);
  assert.equal(a.dominant, "drowsy");
});

test("R is clamped to 100", () => {
  assert.equal(score(vec(Object.fromEntries(FEATURE_NAMES.map((n) => [n, 1]))), DEFAULT_WEIGHTS, { kidsInCar: true, lowExperience: true }).R, 100);
});

test("least squares recovers known weights", () => {
  const truth = Array.from({ length: N_FEATURES }, (_, i) => (i + 1) / 20);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const X = Array.from({ length: 80 }, () => Array.from({ length: N_FEATURES }, rnd));
  const y = X.map((r) => r.reduce((s, v, i) => s + v * truth[i]!, 0));
  const w = leastSquares(X, y, 0)!;
  w.forEach((v, i) => assert.ok(Math.abs(v - truth[i]!) < 1e-6));
  const { weights, fits } = fitWeights(X.map((x, i) => ({ x, y: y[i]!, target: "drowsy" as const })), DEFAULT_WEIGHTS, { ridge: 0 });
  assert.ok(fits.drowsy!.rmse < 1e-6);
  assert.deepEqual(weights.reckless, DEFAULT_WEIGHTS.reckless); // no reckless labels -> untouched
});

test("adapt: dismiss lowers the firing score, confirm raises it, others untouched", () => {
  const x = vec({ eye_closure: 0.9, engagement: 0.8 });
  const before = score(x, DEFAULT_WEIGHTS, none);
  const down = score(x, adapt(DEFAULT_WEIGHTS, "drowsy", x, "dismissed"), none);
  const up = score(x, adapt(DEFAULT_WEIGHTS, "drowsy", x, "confirmed"), none);
  assert.ok(down.drowsy < before.drowsy && up.drowsy > before.drowsy);
  assert.deepEqual(adapt(DEFAULT_WEIGHTS, "drowsy", x, "dismissed").reckless, DEFAULT_WEIGHTS.reckless);
});

const drowsyWindow = (ts: number, f = 1) => ({
  ts,
  features: { eye_closure: f, engagement: f, breathing_dev: f, heart_rate_dev: f, hours_driving: f, night_time: f },
  ctx: none,
  sharingOn: true,
});

test("tier must hold 15 s before firing, then respects the 2 min cooldown", () => {
  const e = new RiskEngine("t");
  assert.equal(e.ingest(drowsyWindow(T0)).decision, null); // 10 s of evidence
  const fired = e.ingest(drowsyWindow(T0 + 10_000)).decision; // 20 s
  assert.equal(fired?.tier, 85);
  assert.equal(fired?.notify, "contacts");
  assert.equal(e.ingest(drowsyWindow(T0 + 20_000)).decision, null);
  assert.equal(e.ingest(drowsyWindow(T0 + 100_000)).decision, null);
  assert.equal(e.ingest(drowsyWindow(T0 + 140_000)).decision?.tier, 85);
});

test("a single spike doesn't fire (flicker guard)", () => {
  const e = new RiskEngine("t");
  e.ingest(drowsyWindow(T0));
  e.ingest(drowsyWindow(T0 + 10_000, 0));
  assert.equal(e.ingest(drowsyWindow(T0 + 20_000)).decision, null);
});

// Mid-risk feature set: R between 70 and 85 for the default weights.
const mid = (ts: number) => ({ ts, features: { eye_closure: 0.9, engagement: 0.8, breathing_dev: 0.5, hours_driving: 0.5 }, ctx: none, sharingOn: false });

test("tier 70 drowsy routes to a rest stop; kids bump it to 85; sharing off asks permission", () => {
  const e = new RiskEngine("t");
  e.ingest(mid(T0));
  const d = e.ingest(mid(T0 + 10_000));
  assert.ok(d.score.R >= 70 && d.score.R < 85, String(d.score.R));
  assert.equal(d.decision?.tier, 70);
  assert.equal(d.decision?.routeToRestStop, true);

  const k = new RiskEngine("t");
  // With kids on (m = 1.25) this stays in 70..85, so only the bump can take it to 85.
  const low = (ts: number) => ({ ts, features: { eye_closure: 0.9, engagement: 0.7, breathing_dev: 0.4 }, ctx: { ...none, kidsInCar: true }, sharingOn: false });
  k.ingest(low(T0));
  const r = k.ingest(low(T0 + 10_000));
  assert.ok(r.score.R >= 70 && r.score.R < 85, String(r.score.R));
  assert.equal(r.decision?.tier, 85);
  assert.equal(r.decision?.reason, "kids_bump");
  assert.equal(r.decision?.notify, "ask_permission");
});

test("70+ held for 2 minutes escalates to 85", () => {
  const e = new RiskEngine("t");
  const out: (number | undefined)[] = [];
  for (let i = 0; i < 14; i++) out.push(e.ingest(mid(T0 + i * 10_000)).decision?.tier);
  assert.equal(out[1], 70);
  assert.ok(out.slice(2, 11).every((t) => t === undefined)); // 70 cooldown
  assert.equal(out[11], 85); // 120 s of evidence
});

test("'I'm fine' feeds back into the weights; stale feedback is ignored", async () => {
  const e = new RiskEngine("t");
  e.ingest(mid(T0));
  const r = e.ingest(mid(T0 + 10_000));
  const before = score(r.x, e.weights, none).drowsy;
  assert.equal(await e.feedback("dismissed", T0 + 20_000), true);
  assert.ok(score(r.x, e.weights, none).drowsy < before);
  assert.equal(await e.feedback("dismissed", T0 + 20 * 60_000), false);
});
