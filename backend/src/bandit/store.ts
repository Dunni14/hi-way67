// Persistence for the bandit (Tiger Data = Postgres + TimescaleDB, `TIGER_DATABASE_URL`).
// Works with `pg` and with PGlite in tests (no TimescaleDB there, so the hypertable step is best-effort).
import type { Db } from "../risk/store/pg.ts";
import type { Model } from "./linucb.ts";

export type BanditEvent = {
  ts: string;
  driverId: string;
  tripId: string;
  tier: 1 | 2;
  dominant: "drowsy" | "reckless";
  action: string;
  context: number[];
  scores: Record<string, number>;
  reward: number | null;
  rewardTs: string | null;
  falseAlarm: boolean;
};

export type PolicyRow = { action: string; updates: number; meanReward: number | null };

export interface BanditStore {
  getModels(driverId: string, actions: string[]): Promise<Record<string, Model | undefined>>;
  saveModel(driverId: string, action: string, m: Model): Promise<void>;
  addEvent(e: Omit<BanditEvent, "reward" | "rewardTs" | "falseAlarm">): Promise<void>;
  countEvents(tripId: string): Promise<number>;
  /** Events with no reward decision yet whose reward period has ended by `dueTs`. */
  pendingEvents(tripId: string, dueTs: string, delayS: number): Promise<BanditEvent[]>;
  /** `reward` null = decided not to learn from this one. */
  resolveEvent(tripId: string, ts: string, reward: number | null, rewardTs: string): Promise<void>;
  /** Flag still-pending interventions whose reward period covers `windowTs`. */
  markFalseAlarm(tripId: string, windowTs: string, delayS: number): Promise<void>;
  policy(driverId: string): Promise<PolicyRow[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bandit_events (
     ts          TIMESTAMPTZ NOT NULL,
     driver_id   TEXT NOT NULL,
     trip_id     TEXT NOT NULL,
     tier        INT NOT NULL,
     dominant    TEXT NOT NULL,
     action      TEXT NOT NULL,
     context     DOUBLE PRECISION[] NOT NULL,
     scores      JSONB NOT NULL,
     reward      DOUBLE PRECISION,
     reward_ts   TIMESTAMPTZ,
     false_alarm BOOLEAN NOT NULL DEFAULT FALSE
   )`,
  `CREATE INDEX IF NOT EXISTS bandit_events_trip_ts ON bandit_events (trip_id, ts)`,
  `CREATE INDEX IF NOT EXISTS bandit_events_driver ON bandit_events (driver_id, action)`,
  `CREATE TABLE IF NOT EXISTS bandit_models (
     driver_id TEXT NOT NULL,
     action    TEXT NOT NULL,
     a_matrix  DOUBLE PRECISION[] NOT NULL,
     b_vector  DOUBLE PRECISION[] NOT NULL,
     updates   INT NOT NULL DEFAULT 0,
     PRIMARY KEY (driver_id, action)
   )`,
];

const iso = (v: Date | string) => new Date(v).toISOString();
const toEvent = (r: any): BanditEvent => ({
  ts: iso(r.ts),
  driverId: r.driver_id,
  tripId: r.trip_id,
  tier: r.tier,
  dominant: r.dominant,
  action: r.action,
  context: r.context,
  scores: r.scores,
  reward: r.reward,
  rewardTs: r.reward_ts == null ? null : iso(r.reward_ts),
  falseAlarm: r.false_alarm,
});

export class PgBanditStore implements BanditStore {
  constructor(private db: Db) {}

  /** Create tables if missing. Safe to call on every boot. */
  async migrate() {
    for (const stmt of SCHEMA) await this.db.query(stmt);
    // Hypertable on ts. Not fatal where TimescaleDB is absent (plain Postgres, PGlite).
    try {
      await this.db.query(`SELECT create_hypertable('bandit_events', 'ts', if_not_exists => TRUE)`);
    } catch (e) {
      console.warn("[bandit] bandit_events left as a plain table (no TimescaleDB):", (e as Error).message);
    }
  }

  async getModels(driverId: string, actions: string[]) {
    const { rows } = await this.db.query(`SELECT * FROM bandit_models WHERE driver_id = $1 AND action = ANY($2::text[])`, [driverId, actions]);
    return Object.fromEntries(rows.map((r): [string, Model] => [r.action, { A: r.a_matrix, b: r.b_vector, updates: r.updates }]));
  }

  async saveModel(driverId: string, action: string, m: Model) {
    await this.db.query(
      `INSERT INTO bandit_models (driver_id, action, a_matrix, b_vector, updates) VALUES ($1,$2,$3::float8[],$4::float8[],$5)
       ON CONFLICT (driver_id, action) DO UPDATE SET a_matrix = $3::float8[], b_vector = $4::float8[], updates = $5`,
      [driverId, action, m.A, m.b, m.updates],
    );
  }

  async addEvent(e: Omit<BanditEvent, "reward" | "rewardTs" | "falseAlarm">) {
    await this.db.query(
      `INSERT INTO bandit_events (ts, driver_id, trip_id, tier, dominant, action, context, scores) VALUES ($1,$2,$3,$4,$5,$6,$7::float8[],$8::jsonb)`,
      [e.ts, e.driverId, e.tripId, e.tier, e.dominant, e.action, e.context, JSON.stringify(e.scores)],
    );
  }

  async countEvents(tripId: string) {
    const { rows } = await this.db.query(`SELECT count(*)::int AS n FROM bandit_events WHERE trip_id = $1`, [tripId]);
    return rows[0].n as number;
  }

  async pendingEvents(tripId: string, dueTs: string, delayS: number) {
    const { rows } = await this.db.query(
      `SELECT * FROM bandit_events WHERE trip_id = $1 AND reward_ts IS NULL AND ts + make_interval(secs => $3) <= $2 ORDER BY ts ASC`,
      [tripId, dueTs, delayS],
    );
    return rows.map(toEvent);
  }

  async resolveEvent(tripId: string, ts: string, reward: number | null, rewardTs: string) {
    await this.db.query(`UPDATE bandit_events SET reward = $3, reward_ts = $4 WHERE trip_id = $1 AND ts = $2`, [tripId, ts, reward, rewardTs]);
  }

  async markFalseAlarm(tripId: string, windowTs: string, delayS: number) {
    await this.db.query(
      `UPDATE bandit_events SET false_alarm = TRUE
       WHERE trip_id = $1 AND reward_ts IS NULL AND ts <= $2 AND ts + make_interval(secs => $3) >= $2`,
      [tripId, windowTs, delayS],
    );
  }

  async policy(driverId: string) {
    const { rows } = await this.db.query(
      `SELECT m.action, m.updates, (SELECT avg(e.reward) FROM bandit_events e WHERE e.driver_id = m.driver_id AND e.action = m.action AND e.reward IS NOT NULL) AS mean_reward
       FROM bandit_models m WHERE m.driver_id = $1`,
      [driverId],
    );
    return rows.map((r): PolicyRow => ({ action: r.action, updates: r.updates, meanReward: r.mean_reward == null ? null : Number(r.mean_reward) }));
  }
}
