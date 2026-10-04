// The fake database must behave like Tiger: same schema, seeded config, believable history,
// and the real service/report code runs on top of it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openFakeDb, type FakeDb } from "../dev/fakeDb.ts";

let fake: FakeDb;
before(async () => {
  fake = await openFakeDb();
});
after(async () => {
  await fake.db.close();
});

test("seeds config tables and a week of trips", async () => {
  assert.deepEqual(fake.seeded, { trips: 12, windows: 1150 });
  const { rows } = await fake.db.query(`SELECT (SELECT count(*) FROM risk_factors)::int AS rf, (SELECT count(*) FROM tiers)::int AS t, (SELECT count(*) FROM trips WHERE ended_at IS NOT NULL)::int AS done`);
  assert.deepEqual(rows[0], { rf: 6, t: 4, done: 12 });
});

test("history covers every tier and all three sharing modes", async () => {
  const tiers = (await fake.db.query(`SELECT DISTINCT tier FROM windows ORDER BY tier`)).rows.map((r: any) => r.tier);
  assert.deepEqual(tiers, [0, 1, 2, 3]);
  const modes = (await fake.db.query(`SELECT DISTINCT sharing_mode FROM drivers WHERE driver_id IN ('alex','sam','jo') ORDER BY 1`)).rows.map((r: any) => r.sharing_mode);
  assert.deepEqual(modes, ["always", "high_risk_only", "never"]);
});

test("service reads work on seeded data (trips, report, events)", async () => {
  const trips: any = await fake.service.driverTrips("alex");
  assert.equal((trips.trips ?? trips).length, 5);
  const report: any = await fake.service.report("fake-alex-2"); // the drowsy trip
  assert.ok(["C", "D"].includes(report.grade), `expected a poor grade, got ${report.grade}`);
  assert.ok((await fake.store.getEvents("fake-alex-2")).length > 0);
});

test("aggregate stand-in views answer the Tiger queries", async () => {
  assert.ok(((await fake.db.query(`SELECT count(*)::int AS n FROM windows_30s`)).rows[0] as any).n > 0);
  assert.ok(((await fake.db.query(`SELECT count(*)::int AS n FROM trip_summary_5m WHERE windows_tier3 > 0`)).rows[0] as any).n > 0);
});

test("generation is deterministic", async () => {
  const other = await openFakeDb();
  const q = `SELECT count(*)::int AS n, round(sum(score)::numeric, 3)::float AS s FROM windows`;
  assert.deepEqual((await other.db.query(q)).rows[0], (await fake.db.query(q)).rows[0]);
  await other.db.close();
});

test("every seeded trip has a stored report card, observations and a driver scorecard", async () => {
  const cards = (await fake.db.query(`SELECT trip_id, score, grade, duration_s, distance_mi, tier0_s + tier1_s + tier2_s + tier3_s AS tier_s FROM report_cards ORDER BY trip_id`)).rows as any[];
  assert.equal(cards.length, 12);
  for (const c of cards) assert.ok(c.score >= 0 && c.score <= 100 && c.duration_s > 0 && c.distance_mi > 0, JSON.stringify(c));

  const clean = ((await fake.db.query(`SELECT score FROM report_cards WHERE trip_id = 'fake-alex-4'`)).rows[0] as any).score; // all calm
  const drowsy = ((await fake.db.query(`SELECT score FROM report_cards WHERE trip_id = 'fake-alex-2'`)).rows[0] as any).score;
  assert.ok(clean > 90 && drowsy < clean - 20, `clean ${clean}, drowsy ${drowsy}`);

  assert.ok(((await fake.db.query(`SELECT count(*)::int AS n FROM observations`)).rows[0] as any).n === 1150);
  const alex: any = await fake.service.profile("alex");
  assert.equal(alex.scorecard.scored_trips, 5);
});

test("a trip's report and history survive the raw windows being dropped", async () => {
  const before: any = await fake.service.report("fake-sam-6");
  await fake.db.query(`DELETE FROM windows WHERE trip_id = 'fake-sam-6'`); // what the 7-day retention policy does
  const after: any = await fake.service.report("fake-sam-6");
  assert.equal(after.card.score, before.card.score);
  assert.equal(after.grade, before.grade);
  assert.equal(after.max_score, before.card.metrics.max_risk);
  assert.ok(after.series.length > 0 && after.series.length < before.series.length);
  const hist: any = await fake.service.driverTrips("sam");
  assert.equal((hist.trips ?? hist).find((t: any) => t.trip_id === "fake-sam-6").grade, before.grade);
});
