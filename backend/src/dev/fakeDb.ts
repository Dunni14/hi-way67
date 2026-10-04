// Local stand-in for Tiger Data: an in-process Postgres (PGlite) with the real schema, the seeded
// config tables and a week of generated trips. No network, no credentials, same PgRiskStore code
// path as production. Used when FAKE_DB=1, or as the automatic fallback when DATABASE_URL is
// unreachable at boot (see src/index.ts). Data is deterministic and lives in memory unless
// FAKE_DB_DIR is set.
import { readFileSync } from "node:fs";
import { PgRiskStore, type Db } from "../risk/store/pg.ts";
import { RiskService } from "../risk/service.ts";
import type { SharingMode, SignalWindow } from "../risk/types.ts";

type Exec = Db & { exec(sql: string): Promise<unknown>; close(): Promise<void> };
const sqlFile = (name: string) => readFileSync(new URL(`../../sql/${name}`, import.meta.url), "utf8");

/** Drop the TimescaleDB-only statements; everything else in 01_schema.sql is plain Postgres. */
const TIMESCALE_ONLY = /timescaledb|create_hypertable|MATERIALIZED VIEW|add_\w+_policy/i;
const statements = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

// Plain views standing in for the continuous aggregates (date_bin instead of time_bucket).
const AGGREGATE_VIEWS = `
CREATE OR REPLACE VIEW windows_30s AS
SELECT date_bin(INTERVAL '30 seconds', ts, TIMESTAMPTZ '2000-01-01') AS bucket, trip_id, driver_id,
  avg(heart_rate) AS heart_rate, avg(breathing_rate) AS breathing_rate, avg(drowsy) AS drowsy,
  avg(agitated) AS agitated, avg(speeding) AS speeding, avg(score) AS score, max(tier) AS max_tier
FROM windows GROUP BY 1, trip_id, driver_id;
CREATE OR REPLACE VIEW trip_summary_5m AS
SELECT date_bin(INTERVAL '5 minutes', ts, TIMESTAMPTZ '2000-01-01') AS bucket, trip_id, driver_id,
  avg(score) AS avg_score, max(score) AS max_score,
  count(*) FILTER (WHERE tier = 0) AS windows_tier0, count(*) FILTER (WHERE tier = 1) AS windows_tier1,
  count(*) FILTER (WHERE tier = 2) AS windows_tier2, count(*) FILTER (WHERE tier = 3) AS windows_tier3,
  avg(drowsy) AS avg_drowsy, sum(hard_brakes) AS hard_brakes, sum(swerves) AS swerves
FROM windows GROUP BY 1, trip_id, driver_id;
CREATE OR REPLACE VIEW gps_10s AS
SELECT date_bin(INTERVAL '10 seconds', time, TIMESTAMPTZ '2000-01-01') AS bucket, trip_id, driver_id,
  avg(speed_mps) AS speed_avg_mps, max(speed_mps) AS speed_max_mps, max(accel_mps2) AS accel_max_mps2,
  max(heading_rate_dps) AS heading_rate_dps, (array_agg(lat ORDER BY time DESC))[1] AS lat,
  (array_agg(lon ORDER BY time DESC))[1] AS lon, count(*) AS fixes
FROM gps_samples GROUP BY 1, trip_id, driver_id`;

// ---------------------------------------------------------------------------------------------
// Deterministic data generator

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Scenario = "calm" | "drowsy" | "aggressive" | "phone";
const WINDOW_MS = 10_000;

const makeWindow = (kind: Scenario, i: number, len: number, rnd: () => number, ts: number): SignalWindow => {
  const jitter = (v: number, s: number) => v + (rnd() - 0.5) * s;
  const ramp = Math.min(1, i / Math.max(1, len)); // builds up over the segment
  const w: SignalWindow = {
    ts: new Date(ts).toISOString(),
    face_visible: true,
    heart_rate: jitter(70, 4),
    breathing_rate: jitter(15, 1),
    engagement: 1,
    eye_closure_frac: 0.02 * rnd(),
    longest_eye_closure_s: 0.2 * rnd(),
    yawns: 0,
    emotion_stress: 0.05 * rnd(),
    gaze_off_road_s: 0.5 * rnd(),
    phone_in_hand: false,
    hard_brakes: 0,
    swerves: 0,
    speed_mph: jitter(58, 6),
    speed_limit_mph: 65,
  };
  if (kind === "drowsy") {
    w.heart_rate = jitter(62 - 6 * ramp, 3);
    w.breathing_rate = jitter(13 - 2 * ramp, 1);
    w.engagement = 1 - 0.6 * ramp;
    w.eye_closure_frac = 0.15 + 0.35 * ramp * rnd();
    w.longest_eye_closure_s = 0.4 + 1.8 * ramp * rnd();
    w.yawns = rnd() < 0.3 + 0.4 * ramp ? 1 : 0;
    w.swerves = rnd() < 0.2 * ramp ? 1 : 0;
  } else if (kind === "aggressive") {
    w.heart_rate = jitter(92, 6);
    w.breathing_rate = jitter(19, 2);
    w.emotion_stress = 0.6 + 0.4 * rnd();
    w.speed_mph = jitter(82, 6);
    w.hard_brakes = rnd() < 0.35 ? 1 : 0;
    w.swerves = rnd() < 0.25 ? 1 : 0;
  } else if (kind === "phone") {
    w.phone_in_hand = rnd() < 0.8;
    w.gaze_off_road_s = 2 + 3 * rnd();
    w.engagement = 0.5;
    w.swerves = rnd() < 0.1 ? 1 : 0;
  }
  return w;
};

type TripPlan = { driver: string; daysAgo: number; segments: [Scenario, number][]; kids?: boolean; sleepHours?: number };

const DRIVERS: { id: string; name: string; sharing: SharingMode; kids: boolean; lowExp: boolean }[] = [
  { id: "alex", name: "Alex", sharing: "high_only", kids: false, lowExp: false },
  { id: "sam", name: "Sam", sharing: "always", kids: true, lowExp: false },
  { id: "jo", name: "Jo", sharing: "never", kids: false, lowExp: true },
];

const PLANS: TripPlan[] = [
  { driver: "alex", daysAgo: 6, segments: [["calm", 90]] },
  { driver: "alex", daysAgo: 5, segments: [["calm", 40], ["phone", 15], ["calm", 40]] },
  { driver: "alex", daysAgo: 4, segments: [["calm", 30], ["drowsy", 70]], sleepHours: 4.5 },
  { driver: "alex", daysAgo: 2, segments: [["calm", 60], ["aggressive", 25], ["calm", 30]] },
  { driver: "alex", daysAgo: 1, segments: [["calm", 120]], sleepHours: 8 },
  { driver: "sam", daysAgo: 6, segments: [["calm", 70], ["aggressive", 20]], kids: true },
  { driver: "sam", daysAgo: 3, segments: [["calm", 50], ["drowsy", 60]], kids: true, sleepHours: 5 },
  { driver: "sam", daysAgo: 2, segments: [["calm", 100]] },
  { driver: "sam", daysAgo: 0, segments: [["calm", 40], ["phone", 25], ["calm", 20]] },
  { driver: "jo", daysAgo: 5, segments: [["calm", 45], ["aggressive", 30]] },
  { driver: "jo", daysAgo: 3, segments: [["calm", 80]] },
  { driver: "jo", daysAgo: 1, segments: [["calm", 25], ["drowsy", 55], ["calm", 10]], sleepHours: 3.5 },
];

export type FakeDb = { db: Exec; store: PgRiskStore; service: RiskService; seeded: { trips: number; windows: number } };

export async function openFakeDb(opts: { dir?: string; seed?: boolean } = {}): Promise<FakeDb> {
  const { PGlite } = await import("@electric-sql/pglite"); // dev-time dependency, loaded only when needed
  const db = (opts.dir ? new PGlite(opts.dir) : new PGlite()) as unknown as Exec;
  const store = new PgRiskStore(db);

  for (const s of statements(sqlFile("01_schema.sql")).filter((s) => !TIMESCALE_ONLY.test(s))) await db.query(s);
  await store.migrate(); // adds windows.result, same as on Tiger
  await db.exec(AGGREGATE_VIEWS);
  await db.exec(sqlFile("02_seed.sql"));

  const service = new RiskService(store);
  const seeded = { trips: 0, windows: 0 };
  const empty = ((await db.query(`SELECT count(*)::int AS n FROM trips`)).rows[0] as { n: number }).n === 0;
  if (opts.seed !== false && empty) {
    const now = Date.now();
    for (const [pi, plan] of PLANS.entries()) {
      const d = DRIVERS.find((x) => x.id === plan.driver)!;
      const rnd = mulberry32(1000 + pi);
      const len = plan.segments.reduce((n, [, c]) => n + c, 0);
      const start = now - plan.daysAgo * 86_400_000 - (len + 5) * WINDOW_MS - (pi % 4) * 3_600_000;
      await store.upsertDriver(d.id, d.sharing);
      await db.query(`UPDATE drivers SET display_name = $2, has_family_voice = $3 WHERE driver_id = $1`, [d.id, d.name, d.kids]);
      const tripId = `fake-${plan.driver}-${pi}`;
      await store.createTrip({
        id: tripId, driverId: d.id, startedAt: new Date(start).toISOString(),
        kidsInCar: plan.kids ?? d.kids, lowExperience: d.lowExp, sleepHours: plan.sleepHours ?? null,
      });
      let n = 0;
      for (const [kind, count] of plan.segments) {
        for (let i = 0; i < count; i++, n++) {
          const w = makeWindow(n < 8 ? "calm" : kind, i, count, rnd, start + (n + 1) * WINDOW_MS);
          if (n < 8) Object.assign(w, { heart_rate: 70 + (rnd() - 0.5) * 2, breathing_rate: 15 + (rnd() - 0.5) * 0.5 });
          await service.ingestWindow(tripId, w);
          seeded.windows++;
        }
      }
      await store.endTrip(tripId, new Date(start + (len + 1) * WINDOW_MS).toISOString());
      seeded.trips++;
    }
  }
  return { db, store, service, seeded };
}
