// Postgres-backed RiskStore. Works with `pg` (Pool/Client) in production and with
// PGlite in tests: both expose `query(sql, params) -> { rows }`.
import { SCHEMA_SQL } from "./schema.ts";
import type { Baseline } from "../smoothing.ts";
import type { Observation } from "../expression.ts";
import type { DriverProfile } from "../profile.ts";
import type { Action } from "../types.ts";
import type { CardRow, DecisionRow, DriverRow, EventRow, RiskStore, TripRow, WindowRow } from "./types.ts";
import type { Override, SharingMode } from "../types.ts";

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v == null ? null : iso(v));

// The schema names the middle sharing mode `high_risk_only`; the API says `high_only`.
const sharingToDb = (m: SharingMode | null | undefined) => (m === "high_only" ? "high_risk_only" : (m ?? null));
const sharingFromDb = (m: string): SharingMode => (m === "high_risk_only" ? "high_only" : (m as SharingMode));

// events.override stores override_rules.rule_id (seeded in sql/02_seed.sql).
const OVERRIDE_IDS: Record<Override, number> = { microsleep: 1, drowsy_sustained_3: 2, drowsy_sustained_12: 3, tier2_sustained_12: 4 };
const overrideFromId = (id: number | null): Override | null =>
  id == null ? null : ((Object.keys(OVERRIDE_IDS) as Override[]).find((k) => OVERRIDE_IDS[k] === id) ?? null);

const toDriver = (r: any): DriverRow => ({ id: r.driver_id, sharingMode: sharingFromDb(r.sharing_mode), weightOverrides: r.weight_overrides ?? {}, profile: r.profile ?? {} });
const toTrip = (r: any): TripRow => ({
  id: r.trip_id,
  driverId: r.driver_id,
  startedAt: iso(r.started_at),
  endedAt: isoOrNull(r.ended_at),
  kidsInCar: r.kids_in_car,
  lowExperience: r.low_experience,
  sleepHours: r.sleep_hours,
  baseline: r.base_hr == null && r.base_br == null ? null : { heartRate: r.base_hr, breathingRate: r.base_br },
});
const toWindow = (r: any): WindowRow => ({
  tripId: r.trip_id,
  ts: iso(r.ts),
  raw: {
    ts: iso(r.ts),
    face_visible: r.face_visible,
    heart_rate: r.heart_rate,
    breathing_rate: r.breathing_rate,
    engagement: r.engagement,
    eye_closure_frac: r.eye_closure_frac,
    longest_eye_closure_s: r.longest_eye_closure_s,
    yawns: r.yawns,
    emotion_stress: r.emotion_stress,
    gaze_off_road_s: r.gaze_off_road_s,
    phone_in_hand: r.phone_in_hand,
    hard_brakes: r.hard_brakes,
    swerves: r.swerves,
    speed_mph: r.speed_mph,
    speed_limit_mph: r.speed_limit_mph,
  },
  result: r.result,
  score: r.score,
  tier: r.tier,
});

export class PgRiskStore implements RiskStore {
  constructor(private db: Db) {}

  /** Create tables if missing. Safe to call on every boot. */
  async migrate() {
    // One statement at a time: simple-protocol multi-statement support differs between drivers.
    for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) await this.db.query(stmt);
  }

  async upsertDriver(id: string, sharingMode?: SharingMode) {
    const { rows } = await this.db.query(
      `INSERT INTO drivers (driver_id, sharing_mode) VALUES ($1, COALESCE($2, 'high_risk_only'))
       ON CONFLICT (driver_id) DO UPDATE SET sharing_mode = COALESCE($2, drivers.sharing_mode)
       RETURNING *`,
      [id, sharingToDb(sharingMode)],
    );
    return toDriver(rows[0]);
  }

  async getDriver(id: string) {
    const { rows } = await this.db.query(`SELECT * FROM drivers WHERE driver_id = $1`, [id]);
    return rows[0] ? toDriver(rows[0]) : null;
  }

  async setWeightOverrides(id: string, overrides: object) {
    await this.db.query(`UPDATE drivers SET weight_overrides = $2::jsonb WHERE driver_id = $1`, [id, JSON.stringify(overrides)]);
  }

  async createTrip(t: Omit<TripRow, "endedAt" | "baseline">) {
    await this.db.query(
      `INSERT INTO trips (trip_id, driver_id, started_at, kids_in_car, low_experience, sleep_hours) VALUES ($1,$2,$3,$4,$5,$6)`,
      [t.id, t.driverId, t.startedAt, t.kidsInCar, t.lowExperience, t.sleepHours],
    );
  }

  async getTrip(id: string) {
    const { rows } = await this.db.query(`SELECT * FROM trips WHERE trip_id = $1`, [id]);
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async endTrip(id: string, endedAt: string) {
    await this.db.query(`UPDATE trips SET ended_at = $2 WHERE trip_id = $1`, [id, endedAt]);
  }

  async setBaseline(id: string, baseline: Baseline) {
    await this.db.query(`UPDATE trips SET base_hr = $2, base_br = $3 WHERE trip_id = $1`, [id, baseline.heartRate, baseline.breathingRate]);
  }

  async listTrips(driverId: string) {
    const { rows } = await this.db.query(`SELECT * FROM trips WHERE driver_id = $1 ORDER BY started_at DESC`, [driverId]);
    return rows.map(toTrip);
  }

  async addWindow(w: WindowRow) {
    const { raw: r, result: e } = w;
    const { rows } = await this.db.query(
      `INSERT INTO windows (ts, trip_id, driver_id,
         face_visible, heart_rate, breathing_rate, engagement, eye_closure_frac, longest_eye_closure_s, yawns,
         emotion_stress, gaze_off_road_s, phone_in_hand, hard_brakes, swerves, speed_mph, speed_limit_mph,
         drowsy, agitated, speeding, phone, distracted, erratic,
         score, tier, dominant, degraded, result)
       SELECT $1, $2, t.driver_id,
         $3,$4,$5,$6,$7,$8,$9,
         $10,$11,$12,$13,$14,$15,$16,
         $17,$18,$19,$20,$21,$22,
         $23,$24,$25,$26,$27::jsonb
       FROM trips t WHERE t.trip_id = $2
       ON CONFLICT DO NOTHING RETURNING trip_id`,
      [
        w.ts, w.tripId,
        r.face_visible ?? null, r.heart_rate ?? null, r.breathing_rate ?? null, r.engagement ?? null, r.eye_closure_frac ?? null,
        r.longest_eye_closure_s ?? null, r.yawns == null ? null : Math.round(r.yawns),
        r.emotion_stress ?? null, r.gaze_off_road_s ?? null, r.phone_in_hand ?? null,
        r.hard_brakes == null ? null : Math.round(r.hard_brakes), r.swerves == null ? null : Math.round(r.swerves),
        r.speed_mph ?? null, r.speed_limit_mph ?? null,
        e.levels.drowsy, e.levels.agitated, e.levels.speeding, e.levels.phone, e.levels.distracted, e.levels.erratic,
        w.score, w.tier, e.dominant, e.degraded, JSON.stringify(e),
      ],
    );
    return rows.length > 0;
  }

  async getWindows(tripId: string) {
    const { rows } = await this.db.query(`SELECT * FROM windows WHERE trip_id = $1 ORDER BY ts ASC`, [tripId]);
    return rows.map(toWindow);
  }

  async getWindow(tripId: string, ts: string) {
    const { rows } = await this.db.query(`SELECT * FROM windows WHERE trip_id = $1 AND ts = $2`, [tripId, ts]);
    return rows[0] ? toWindow(rows[0]) : null;
  }

  async addEvent(e: EventRow) {
    // dominant and score come from the window written for the same (trip, ts).
    await this.db.query(
      `INSERT INTO events (ts, trip_id, driver_id, tier, dominant, actions, override, score)
       SELECT $1, $2, t.driver_id, $3, w.dominant, $4::text[], $5::int, w.score
       FROM trips t LEFT JOIN windows w ON w.trip_id = t.trip_id AND w.ts = $1
       WHERE t.trip_id = $2
       ON CONFLICT DO NOTHING`,
      [e.ts, e.tripId, e.tier, e.actions, e.override ? OVERRIDE_IDS[e.override] : null],
    );
  }

  async getEvents(tripId: string) {
    const { rows } = await this.db.query(`SELECT * FROM events WHERE trip_id = $1 ORDER BY ts ASC`, [tripId]);
    return rows.map((r): EventRow => ({ tripId: r.trip_id, ts: iso(r.ts), tier: r.tier, actions: r.actions, override: overrideFromId(r.override) }));
  }

  async setProfile(id: string, profile: DriverProfile) {
    await this.db.query(`UPDATE drivers SET profile = $2::jsonb WHERE driver_id = $1`, [id, JSON.stringify(profile)]);
  }

  async addObservation(o: Observation & { tripId: string }) {
    await this.db.query(
      `INSERT INTO observations (ts, trip_id, driver_id, expression, intensity, face_visible, stress, engagement, eye_closure_frac, yawns, gaze_off_road_s)
       SELECT $1, $2, t.driver_id, $3, $4, $5, $6, $7, $8, $9, $10 FROM trips t WHERE t.trip_id = $2
       ON CONFLICT DO NOTHING`,
      [o.ts, o.tripId, o.expression, o.intensity, o.face_visible, o.stress, o.engagement, o.eye_closure_frac, o.yawns, o.gaze_off_road_s],
    );
  }

  async getObservations(tripId: string) {
    const { rows } = await this.db.query(`SELECT * FROM observations WHERE trip_id = $1 ORDER BY ts ASC`, [tripId]);
    return rows.map(
      (r): Observation => ({
        ts: iso(r.ts), expression: r.expression, intensity: r.intensity, face_visible: r.face_visible, stress: r.stress,
        engagement: r.engagement, eye_closure_frac: r.eye_closure_frac, yawns: r.yawns, gaze_off_road_s: r.gaze_off_road_s,
      }),
    );
  }

  async saveCard(c: CardRow) {
    await this.db.query(
      `INSERT INTO report_cards (trip_id, driver_id, created_at, formula_version, score, grade, confidence, card, features)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::double precision[])
       ON CONFLICT (trip_id) DO NOTHING`,
      [c.tripId, c.driverId, c.createdAt, c.card.formula_version, c.card.score, c.card.grade, c.card.confidence, JSON.stringify(c.card), c.card.features],
    );
    await this.db.query(`UPDATE trips SET grade = $2 WHERE trip_id = $1`, [c.tripId, c.card.grade]);
  }

  async getCard(tripId: string) {
    const { rows } = await this.db.query(`SELECT * FROM report_cards WHERE trip_id = $1`, [tripId]);
    const r = rows[0];
    return r ? ({ tripId: r.trip_id, driverId: r.driver_id, createdAt: iso(r.created_at), card: r.card } satisfies CardRow) : null;
  }

  async addDecision(d: DecisionRow) {
    await this.db.query(
      `INSERT INTO decision_log (ts, driver_id, trip_id, tier, dominant, action, context, scores)
       SELECT $1, t.driver_id, $2, $3, $4, $5, $6::double precision[], $7::jsonb FROM trips t WHERE t.trip_id = $2
       ON CONFLICT DO NOTHING`,
      [d.ts, d.tripId, d.tier, d.dominant, d.action, d.context, JSON.stringify(d.scores)],
    );
  }

  async rewardDecision(tripId: string, ts: string, reward: number) {
    const { rows } = await this.db.query(
      `UPDATE decision_log SET reward = $3, reward_ts = now() WHERE trip_id = $1 AND ts = $2 RETURNING action`,
      [tripId, ts, reward],
    );
    return (rows[0]?.action ?? null) as Action | null;
  }
}
