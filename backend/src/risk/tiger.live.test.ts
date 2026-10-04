// Live checks against a real Tiger Data / TimescaleDB service. Skipped unless DATABASE_URL is set.
// Covers what PGlite can't: events insert, continuous aggregates, retention policy, config seed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PgRiskStore } from "./store/pg.ts";
import { RiskService } from "./service.ts";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set";
const DRIVER = `live-test-${process.pid}`;
const NEUTRAL = {
  face_visible: true, heart_rate: 70, breathing_rate: 15, engagement: 1, eye_closure_frac: 0, longest_eye_closure_s: 0,
  yawns: 0, emotion_stress: 0, gaze_off_road_s: 0, phone_in_hand: false, hard_brakes: 0, swerves: 0, speed_mph: 60, speed_limit_mph: 70,
};

let pool: pg.Pool;
let store: PgRiskStore;
let svc: RiskService;
let tripId = "";

const cleanup = async () => {
  for (const t of ["report_cards", "decision_log", "observations"]) await pool.query(`DELETE FROM ${t} WHERE driver_id = $1`, [DRIVER]);
  await pool.query(`DELETE FROM events WHERE driver_id = $1`, [DRIVER]);
  await pool.query(`DELETE FROM windows WHERE driver_id = $1`, [DRIVER]);
  await pool.query(`DELETE FROM trips WHERE driver_id = $1`, [DRIVER]);
  await pool.query(`DELETE FROM drivers WHERE driver_id = $1`, [DRIVER]);
};

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: url });
  store = new PgRiskStore(pool);
  await store.migrate();
  await store.migrateTimescale();
  svc = new RiskService(store);
  await cleanup();
});
after(async () => {
  if (skip) return;
  await cleanup();
  await pool.query(`CALL refresh_continuous_aggregate('windows_30s', NULL, NULL)`);
  await pool.query(`CALL refresh_continuous_aggregate('trip_summary_5m', NULL, NULL)`);
  await pool.end();
});

test("config tables are seeded", { skip }, async () => {
  const { rows } = await pool.query(`SELECT (SELECT count(*) FROM risk_factors)::int AS rf, (SELECT count(*) FROM override_rules)::int AS orr, (SELECT count(*) FROM tiers)::int AS t`);
  assert.deepEqual(rows[0], { rf: 6, orr: 5, t: 4 });
});

test("microsleep writes window and event, readable through the store", { skip }, async () => {
  const t: any = await svc.startTrip({ driver_id: DRIVER, sharing_mode: "high_only", kids_in_car: false, low_experience: false, sleep_hours: null });
  tripId = t.trip_id;
  const t0 = Date.now() - 20 * 10_000;
  const send = (i: number, o: object = {}) => (svc as any).ingest(tripId, { ...NEUTRAL, ts: new Date(t0 + i * 10_000).toISOString(), ...o });
  for (let i = 0; i < 8; i++) await send(i);
  const last = await send(8, { longest_eye_closure_s: 2.0 });
  assert.equal(last.tier, 3);
  assert.equal(last.override, "microsleep");

  const events = await store.getEvents(tripId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.override, "microsleep");
  const { rows } = await pool.query(`SELECT override, dominant, score FROM events WHERE trip_id = $1`, [tripId]);
  assert.equal(rows[0].override, 1);
  // A microsleep override fires with a raw score of 0, so check the event mirrors its window rather than a value.
  const win = (await pool.query(`SELECT dominant, score FROM windows WHERE trip_id = $1 ORDER BY ts DESC LIMIT 1`, [tripId])).rows[0];
  assert.equal(rows[0].dominant, win.dominant);
  assert.equal(rows[0].score, win.score);
  assert.ok(rows[0].dominant, "dominant is filled in");

  const state = await svc.state(tripId);
  assert.equal(state.tier, 3);
  assert.equal((await store.getWindows(tripId)).length, 9);
});

test("continuous aggregates roll the trip up", { skip }, async () => {
  await pool.query(`CALL refresh_continuous_aggregate('windows_30s', NULL, NULL)`);
  await pool.query(`CALL refresh_continuous_aggregate('trip_summary_5m', NULL, NULL)`);
  const a = await pool.query(`SELECT count(*)::int AS n, max(max_tier) AS tier FROM windows_30s WHERE trip_id = $1`, [tripId]);
  assert.ok(a.rows[0].n >= 1);
  assert.equal(a.rows[0].tier, 3);
  const b = await pool.query(`SELECT sum(windows_tier3)::int AS t3 FROM trip_summary_5m WHERE trip_id = $1`, [tripId]);
  assert.ok(b.rows[0].t3 >= 1);
});

test("retention and aggregate policies are installed", { skip }, async () => {
  const { rows } = await pool.query(`SELECT proc_name, hypertable_name FROM timescaledb_information.jobs WHERE proc_name IN ('policy_retention', 'policy_refresh_continuous_aggregate')`);
  assert.ok(rows.some((r) => r.proc_name === "policy_retention" && r.hypertable_name === "windows"));
  assert.ok(rows.some((r) => r.proc_name === "policy_retention" && r.hypertable_name === "gps_samples"));
  assert.equal(rows.filter((r) => r.proc_name === "policy_refresh_continuous_aggregate").length, 3); // windows_30s, trip_summary_5m, gps_10s
});

test("report-card tables are hypertables with the right policies", { skip }, async () => {
  const hyper = (await pool.query(`SELECT hypertable_name FROM timescaledb_information.hypertables`)).rows.map((r) => r.hypertable_name);
  for (const t of ["windows", "events", "observations", "decision_log"]) assert.ok(hyper.includes(t), `${t} is a hypertable`);
  const jobs = (await pool.query(`SELECT proc_name, hypertable_name FROM timescaledb_information.jobs`)).rows;
  const has = (proc: string, table: string) => jobs.some((j) => j.proc_name === proc && j.hypertable_name === table);
  assert.ok(has("policy_retention", "observations") && has("policy_retention", "windows"));
  assert.ok(has("policy_compression", "windows") && has("policy_compression", "observations") && has("policy_compression", "decision_log"));
  assert.ok(!jobs.some((j) => j.proc_name === "policy_retention" && ["report_cards", "events", "decision_log"].includes(j.hypertable_name)), "long-term tables have no retention");
});

test("ending a trip stores observations, a decision log and a report card that outlives the raw windows", { skip }, async () => {
  const { trip_id } = (await svc.startTrip({ driver_id: DRIVER, kids_in_car: false, low_experience: false, sleep_hours: 7 })) as { trip_id: string };
  const t0 = Date.now() - 30 * 10_000;
  for (let i = 0; i < 30; i++) {
    const o = i < 6 ? {} : { speed_mph: 90, phone_in_hand: true, emotion_stress: 1, heart_rate: 100 };
    await svc.ingestWindow(trip_id, { ...NEUTRAL, ...o, ts: new Date(t0 + i * 10_000).toISOString() });
  }
  const end: any = await svc.endTrip(trip_id);
  assert.ok(end.card.score < 60 && end.card.metrics.duration_s === 300);

  const n = async (table: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE trip_id = $1`, [trip_id])).rows[0].n;
  assert.equal(await n("observations"), 30);
  assert.ok((await n("decision_log")) >= 1);
  const row = (await pool.query(`SELECT score, grade, tier0_s, distance_mi, jsonb_array_length(series) AS pts FROM report_cards WHERE trip_id = $1`, [trip_id])).rows[0];
  assert.equal(row.score, end.card.score);
  assert.ok(row.pts >= 10 && row.distance_mi > 0);

  await pool.query(`DELETE FROM windows WHERE trip_id = $1`, [trip_id]); // what retention does after 7 days
  const report: any = await svc.report(trip_id);
  assert.equal(report.card.score, end.card.score);
  assert.ok(report.series.length >= 10);
  const profile: any = await svc.profile(DRIVER);
  assert.equal(profile.scorecard.scored_trips, 1);
});
