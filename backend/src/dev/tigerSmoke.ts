// Smoke test against a real Tiger Data (Postgres + TimescaleDB) instance.
//   TIGER_DATABASE_URL=postgres://... npm run smoke:tiger
// Creates the tables if missing, drives one throwaway trip through the risk engine and bandit,
// checks the hypertable and the policy endpoint's data, then deletes its own rows.
// DATABASE_URL (risk engine tables) defaults to the same instance.
import assert from "node:assert/strict";
import pg from "pg";
import { PgRiskStore } from "../risk/store/pg.ts";
import { RiskService } from "../risk/service.ts";
import { PgBanditStore } from "../bandit/store.ts";
import { BanditService } from "../bandit/service.ts";

const tigerUrl = process.env.TIGER_DATABASE_URL?.trim();
if (!tigerUrl) throw new Error("Set TIGER_DATABASE_URL");
const riskUrl = process.env.DATABASE_URL?.trim() || tigerUrl;

const tiger = new pg.Pool({ connectionString: tigerUrl });
const risk = riskUrl === tigerUrl ? tiger : new pg.Pool({ connectionString: riskUrl });
const driver = `smoke-${Date.now().toString(36)}`;

try {
  const riskStore = new PgRiskStore(risk);
  await riskStore.migrate();
  console.log(`[smoke] risk store timescale steps: ${(await riskStore.migrateTimescale()) ? "applied" : "skipped (no TimescaleDB)"}`);
  const banditStore = new PgBanditStore(tiger);
  await banditStore.migrate();

  const ext = await tiger.query(`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`);
  const hyper = await tiger.query(`SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'bandit_events'`).catch(() => ({ rows: [] }));
  console.log(`[smoke] timescaledb ${ext.rows[0]?.extversion ?? "NOT installed"}, bandit_events hypertable: ${hyper.rows.length > 0}`);

  const svc = new RiskService(riskStore, undefined, undefined, new BanditService(banditStore));
  const { trip_id } = await svc.startTrip({ driver_id: driver, kids_in_car: false, low_experience: false, sleep_hours: 4 });
  const t0 = Date.now() - 25 * 60_000;
  const base = { face_visible: true, heart_rate: 70, breathing_rate: 15, engagement: 1, eye_closure_frac: 0, longest_eye_closure_s: 0, yawns: 0, emotion_stress: 0, gaze_off_road_s: 0, phone_in_hand: false, hard_brakes: 0, swerves: 0, speed_mph: 60, speed_limit_mph: 70 };
  const drowsy = { eye_closure_frac: 0.3, yawns: 1, engagement: 0.6, breathing_rate: 12 };
  let first: { id: string; learned: boolean } | undefined;
  for (let i = 0; i < 21; i++) {
    const r = await svc.ingestWindow(trip_id, { ...base, ...(i < 6 ? {} : i < 8 ? drowsy : {}), ts: new Date(t0 + i * 10_000).toISOString() });
    if (r.intervention && !first) first = r.intervention;
  }
  assert.ok(first, "an intervention was picked");
  assert.equal(first.id, "calm_checkin");
  assert.equal(first.learned, false);

  const policy = await svc.driverPolicy(driver);
  const row = policy.actions.find((a) => a.action === "calm_checkin")!;
  console.log(`[smoke] intervention=${first.id}, calm_checkin updates=${row.updates}, mean_reward=${row.mean_reward}`);
  assert.equal(row.updates, 1, "reward settled and the model was updated");

  // End the trip: report card, observations and decision log must land in Tiger.
  const ended: any = await svc.endTrip(trip_id);
  const count = async (table: string) => (await risk.query(`SELECT count(*)::int AS n FROM ${table} WHERE trip_id = $1`, [trip_id])).rows[0].n;
  assert.equal(await count("report_cards"), 1, "report card stored");
  assert.equal(await count("observations"), 21, "one observation per window");
  console.log(`[smoke] card score=${ended.card.score} grade=${ended.card.grade}, decision_log rows=${await count("decision_log")}`);
  console.log("[smoke] OK");
} finally {
  const q = (db: pg.Pool, sql: string) => db.query(sql, [driver]).catch((e) => console.warn("[smoke] cleanup:", e.message));
  await q(tiger, `DELETE FROM bandit_events WHERE driver_id = $1`);
  await q(tiger, `DELETE FROM bandit_models WHERE driver_id = $1`);
  for (const t of ["report_cards", "decision_log", "observations", "events", "windows", "trips"]) await q(risk, `DELETE FROM ${t} WHERE driver_id = $1`);
  await q(risk, `DELETE FROM drivers WHERE driver_id = $1`);
  await tiger.end();
  if (risk !== tiger) await risk.end();
}
