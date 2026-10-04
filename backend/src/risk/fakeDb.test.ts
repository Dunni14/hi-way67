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
