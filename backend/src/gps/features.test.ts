// GPS window features, speeding and erratic levels, heading wrap, trip lifecycle (pure, no I/O).
import { test } from "node:test";
import assert from "node:assert/strict";
import { riskConfig as cfg } from "../risk/config.ts";
import { erraticGpsLevel, goodFixes, headingDelta, isStopped, speedingLevel, windowFeatures } from "./features.ts";
import { advanceMotion, initialMotion } from "./lifecycle.ts";
import type { GoodFix, GpsFix } from "./types.ts";

const T0 = Date.parse("2026-10-04T05:26:00Z");
const fix = (k: number, speed: number | null, o: Partial<GpsFix> = {}): GpsFix => ({
  t: new Date(T0 + k * 1000).toISOString(), lat: 42.28, lon: -83.74, speed_mps: speed, heading_deg: 90, h_accuracy_m: 6, ...o,
});
const run = (speeds: number[], o: Partial<GpsFix> = {}) => speeds.map((s, k) => fix(k, s, o));
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("fixes with accuracy over 30 m, negative speed or no accuracy are dropped", () => {
  const fixes = [fix(0, 10, { h_accuracy_m: 31 }), fix(1, 10, { h_accuracy_m: 30 }), fix(2, -1), fix(3, null), fix(4, 10, { h_accuracy_m: null }), fix(5, 10)];
  assert.deepEqual(goodFixes(fixes, cfg).map((f) => f.t), [fixes[1]!.t, fixes[5]!.t]);
});

test("gps_ok needs at least 3 good fixes", () => {
  assert.equal(windowFeatures(run([10, 10]), cfg).gps_ok, false);
  assert.equal(windowFeatures(run([10, 10, 10]), cfg).gps_ok, true);
  assert.equal(windowFeatures(run([10, 10, 10], { h_accuracy_m: 50 }), cfg).gps_ok, false);
  assert.equal(windowFeatures([], cfg).speed_mps, null);
});

test("window features: median and max speed, last good fix, max accel", () => {
  const f = windowFeatures([...run([10, 10, 14, 11]), fix(4, 12, { lat: 42.3, h_accuracy_m: 99 })], cfg);
  assert.equal(f.speed_mps, 10.5);
  assert.equal(f.speed_max_mps, 14);
  assert.equal(f.accel_max_mps2, 4);
  assert.equal(f.last?.lat, 42.28); // the inaccurate fix is not "last good"
});

test("speeding: 0 at the limit, 0.5 at 15 percent over, 1 at 30 percent over, clamped above", () => {
  const L = 20;
  assert.equal(speedingLevel(20, L, true, cfg), 0);
  assert.equal(speedingLevel(15, L, true, cfg), 0);
  near(speedingLevel(23, L, true, cfg), 0.5);
  near(speedingLevel(26, L, true, cfg), 1);
  assert.equal(speedingLevel(40, L, true, cfg), 1);
});

test("speeding never guesses: no limit, no good gps or no speed gives 0", () => {
  assert.equal(speedingLevel(40, null, true, cfg), 0);
  assert.equal(speedingLevel(40, 20, false, cfg), 0);
  assert.equal(speedingLevel(null, 20, true, cfg), 0);
});

test("heading wraps: 359 to 1 degrees is 2, not 358", () => {
  assert.equal(headingDelta(359, 1), 2);
  assert.equal(headingDelta(1, 359), 2);
  assert.equal(headingDelta(10, 350), 20);
  assert.equal(headingDelta(0, 180), 180);
  const f = windowFeatures([fix(0, 10, { heading_deg: 359 }), fix(1, 10, { heading_deg: 1 }), fix(2, 10, { heading_deg: 1 })], cfg);
  assert.equal(f.heading_rate_dps, 2);
});

test("heading is ignored under 3 m/s", () => {
  const slow = windowFeatures([fix(0, 2.9, { heading_deg: 0 }), fix(1, 2.9, { heading_deg: 90 }), fix(2, 2.9, { heading_deg: 180 })], cfg);
  assert.equal(slow.heading_rate_dps, null);
  assert.equal(erraticGpsLevel(slow, cfg), 0);
  const fast = windowFeatures([fix(0, 3, { heading_deg: 0 }), fix(1, 3, { heading_deg: 90 }), fix(2, 3, { heading_deg: 90 })], cfg);
  assert.equal(fast.heading_rate_dps, 90);
  assert.equal(erraticGpsLevel(fast, cfg), 1);
});

test("a negative or missing heading counts as no heading", () => {
  const f = windowFeatures([fix(0, 10, { heading_deg: -1 }), fix(1, 10, { heading_deg: 90 }), fix(2, 10, { heading_deg: null })], cfg);
  assert.equal(f.heading_rate_dps, null);
});

test("erratic gps = max(accel level, heading level) on the hand-set 2.5..5 and 20..45 ramps", () => {
  const f = (accel: number | null, heading: number | null, ok = true) => erraticGpsLevel({ accel_max_mps2: accel, heading_rate_dps: heading, gps_ok: ok }, cfg);
  assert.equal(f(2.5, 20), 0);
  near(f(3.75, 0), 0.5);
  near(f(0, 32.5), 0.5);
  near(f(4, 25), 0.6); // accel 0.6, heading 0.2 -> the larger
  assert.equal(f(9, 90), 1);
  assert.equal(f(9, 90, false), 0);
  assert.equal(f(null, null), 0);
});

test("stopped = good gps and median speed under 1 m/s", () => {
  assert.equal(isStopped(windowFeatures(run([0, 0.2, 0.5]), cfg), cfg), true);
  assert.equal(isStopped(windowFeatures(run([0, 2, 3]), cfg), cfg), false);
  assert.equal(isStopped(windowFeatures(run([0]), cfg), cfg), false); // one fix is not good gps
});

const good = (k: number, speed: number): GoodFix => ({ ms: T0 + k * 1000, t: "", lat: 0, lon: 0, speed_mps: speed, heading_deg: null, h_accuracy_m: 5 });
const series = (from: number, n: number, speed: number) => Array.from({ length: n }, (_, i) => good(from + i, speed));

test("trip starts after 20 s above 4 m/s and a dip resets the run", () => {
  let m = advanceMotion(initialMotion(), series(0, 20, 5), cfg); // 0..19 s: 19 s elapsed
  assert.equal(m.state.phase, "idle");
  m = advanceMotion(m.state, series(20, 1, 5), cfg);
  assert.deepEqual(m.events, ["started"]);
  const dipped = advanceMotion(initialMotion(), [...series(0, 15, 5), good(15, 4), ...series(16, 21, 5)], cfg);
  assert.equal(dipped.events.length, 1);
  assert.equal(dipped.state.phase, "moving");
  assert.equal(advanceMotion(initialMotion(), [...series(0, 15, 5), good(15, 4), ...series(16, 4, 5)], cfg).state.phase, "idle");
});

test("trip ends after 5 minutes under 1 m/s, not before, and only once it has started", () => {
  const moving = advanceMotion(initialMotion(), series(0, 30, 10), cfg).state;
  const t = 30;
  let m = advanceMotion(moving, series(t, 300, 0.2), cfg); // 299 s of stop
  assert.equal(m.state.phase, "moving");
  m = advanceMotion(m.state, series(t + 300, 1, 0.2), cfg);
  assert.deepEqual(m.events, ["ended"]);
  // a creep above 1 m/s resets the stop timer
  const creep = advanceMotion(moving, [...series(t, 200, 0.2), good(t + 200, 1.5), ...series(t + 201, 200, 0.2)], cfg);
  assert.equal(creep.state.phase, "moving");
  // parked and never moved: nothing to end
  assert.equal(advanceMotion(initialMotion(), series(0, 600, 0), cfg).state.phase, "idle");
});
