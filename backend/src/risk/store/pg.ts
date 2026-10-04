// Postgres-backed RiskStore. Works with `pg` (Pool/Client) in production and with
// PGlite in tests: both expose `query(sql, params) -> { rows }`.
import { SCHEMA_SQL } from "./schema.ts";
import type { DriverRow, EventRow, RiskStore, TripRow, WindowRow } from "./types.ts";
import type { SharingMode } from "../types.ts";

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v == null ? null : iso(v));

const toDriver = (r: any): DriverRow => ({ id: r.id, sharingMode: r.sharing_mode, weightOverrides: r.weight_overrides ?? {} });
const toTrip = (r: any): TripRow => ({
  id: r.id,
  driverId: r.driver_id,
  startedAt: iso(r.started_at),
  endedAt: isoOrNull(r.ended_at),
  kidsInCar: r.kids_in_car,
  lowExperience: r.low_experience,
  sleepHours: r.sleep_hours,
  baseline: r.baseline ?? null,
});
const toWindow = (r: any): WindowRow => ({ tripId: r.trip_id, ts: iso(r.ts), raw: r.raw, result: r.result, score: r.score, tier: r.tier });

export class PgRiskStore implements RiskStore {
  constructor(private db: Db) {}

  /** Create tables if missing. Safe to call on every boot. */
  async migrate() {
    // One statement at a time: simple-protocol multi-statement support differs between drivers.
    for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) await this.db.query(stmt);
  }

  async upsertDriver(id: string, sharingMode?: SharingMode) {
    const { rows } = await this.db.query(
      `INSERT INTO drivers (id, sharing_mode) VALUES ($1, COALESCE($2, 'high_only'))
       ON CONFLICT (id) DO UPDATE SET sharing_mode = COALESCE($2, drivers.sharing_mode)
       RETURNING *`,
      [id, sharingMode ?? null],
    );
    return toDriver(rows[0]);
  }

  async getDriver(id: string) {
    const { rows } = await this.db.query(`SELECT * FROM drivers WHERE id = $1`, [id]);
    return rows[0] ? toDriver(rows[0]) : null;
  }

  async setWeightOverrides(id: string, overrides: object) {
    await this.db.query(`UPDATE drivers SET weight_overrides = $2::jsonb WHERE id = $1`, [id, JSON.stringify(overrides)]);
  }

  async createTrip(t: Omit<TripRow, "endedAt" | "baseline">) {
    await this.db.query(
      `INSERT INTO trips (id, driver_id, started_at, kids_in_car, low_experience, sleep_hours) VALUES ($1,$2,$3,$4,$5,$6)`,
      [t.id, t.driverId, t.startedAt, t.kidsInCar, t.lowExperience, t.sleepHours],
    );
  }

  async getTrip(id: string) {
    const { rows } = await this.db.query(`SELECT * FROM trips WHERE id = $1`, [id]);
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async endTrip(id: string, endedAt: string) {
    await this.db.query(`UPDATE trips SET ended_at = $2 WHERE id = $1`, [id, endedAt]);
  }

  async setBaseline(id: string, baseline: object) {
    await this.db.query(`UPDATE trips SET baseline = $2::jsonb WHERE id = $1`, [id, JSON.stringify(baseline)]);
  }

  async listTrips(driverId: string) {
    const { rows } = await this.db.query(`SELECT * FROM trips WHERE driver_id = $1 ORDER BY started_at DESC`, [driverId]);
    return rows.map(toTrip);
  }

  async addWindow(w: WindowRow) {
    const { rows } = await this.db.query(
      `INSERT INTO windows (trip_id, ts, raw, levels, score, tier, result)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING RETURNING trip_id`,
      [w.tripId, w.ts, JSON.stringify(w.raw), JSON.stringify(w.result.levels), w.score, w.tier, JSON.stringify(w.result)],
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
    await this.db.query(`INSERT INTO events (trip_id, ts, tier, actions, override) VALUES ($1,$2,$3,$4::jsonb,$5)`, [
      e.tripId, e.ts, e.tier, JSON.stringify(e.actions), e.override,
    ]);
  }

  async getEvents(tripId: string) {
    const { rows } = await this.db.query(`SELECT * FROM events WHERE trip_id = $1 ORDER BY ts ASC, id ASC`, [tripId]);
    return rows.map((r): EventRow => ({ tripId: r.trip_id, ts: iso(r.ts), tier: r.tier, actions: r.actions, override: r.override }));
  }
}
