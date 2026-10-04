import { test } from "node:test";
import assert from "node:assert/strict";
import { driverStats } from "./stats.ts";
import type { CardRow } from "./store/types.ts";

const card = (createdAt: string, o: { score: number; tiers: number[]; micro?: number; brakes?: number; yawns?: number; night?: boolean; duration?: number; warnings?: number; provisional?: boolean }): CardRow => ({
  tripId: createdAt,
  driverId: "ray",
  createdAt,
  card: {
    score: o.score,
    provisional: o.provisional ?? false,
    components: { microsleeps: o.micro ?? 0 },
    counts: { hard_brakes: o.brakes ?? 0 },
    metrics: {
      duration_s: o.duration ?? 600, night_trip: o.night ?? false, distance_mi: 5, avg_speed_mph: 60,
      tier_seconds: o.tiers, yawns: o.yawns ?? 0, longest_eye_closure_s: o.micro ? 2.2 : 0.3,
      interventions: { voice_warning: o.warnings ?? 0, voice_urgent: o.micro ?? 0 },
    },
  } as never,
});

const now = new Date(2026, 9, 4, 5, 0); // Sun Oct 4 2026, 05:00 local

test("empty week: nulls, seven empty days, no tips", () => {
  const s = driverStats("ray", [], now);
  assert.equal(s.trips, 0);
  assert.equal(s.safety_score, null);
  assert.equal(s.daily.length, 7);
  assert.deepEqual(s.daily.map((d) => d.label), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.equal(s.attention.value, null);
  assert.deepEqual(s.tips, []);
});

test("summarizes trips, safe trips, risk events, days and tips", () => {
  const s = driverStats("ray", [
    card(new Date(2026, 9, 1, 9).toISOString(), { score: 95, tiers: [600, 0, 0, 0] }),
    card(new Date(2026, 9, 4, 3).toISOString(), { score: 55, tiers: [300, 100, 100, 100], micro: 1, warnings: 1, brakes: 3, yawns: 6, night: true }),
    card(new Date(2026, 9, 4, 4).toISOString(), { score: 20, tiers: [10, 0, 0, 0], provisional: true }),
  ], now);
  assert.equal(s.trips, 3);
  assert.equal(s.safety_score, 75); // provisional trip left out of the mean
  assert.equal(s.safe_trips, 2);
  assert.equal(s.risk_events, 2); // one warning + one urgent
  assert.equal(s.daily.find((d) => d.label === "Thu")!.score, 95);
  assert.equal(s.daily.at(-1)!.trips, 2);
  assert.equal(s.daily.at(-1)!.score, 55); // provisional trip left out of the bar too
  assert.equal(s.eye_tracking.value, "CLOSING");
  assert.equal(s.attention.value, "FAIR"); // 910 of 1210 s calm = 0.75
  assert.deepEqual(s.tips.map((t) => t.title), ["Rest before you drive", "Watch for tiredness", "Leave more following distance"]);
});

test("a calm week says keep it up", () => {
  const s = driverStats("ray", [card(new Date(2026, 9, 3, 12).toISOString(), { score: 98, tiers: [900, 0, 0, 0] })], now);
  assert.equal(s.attention.value, "GOOD");
  assert.equal(s.eye_tracking.value, "NORMAL");
  assert.deepEqual(s.tips.map((t) => t.title), ["Keep it up"]);
});
