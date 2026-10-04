// Postgres schema (spec §9). Idempotent so it can run on every boot.
// Tiger Data / TimescaleDB: `windows` is ready to become a hypertable on `ts`
// (its primary key already includes `ts`). Enable with:
//   SELECT create_hypertable('windows', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS drivers (
  id               TEXT PRIMARY KEY,
  sharing_mode     TEXT NOT NULL DEFAULT 'high_only',
  weight_overrides JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS trips (
  id             TEXT PRIMARY KEY,
  driver_id      TEXT NOT NULL REFERENCES drivers(id),
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  kids_in_car    BOOLEAN NOT NULL DEFAULT FALSE,
  low_experience BOOLEAN NOT NULL DEFAULT FALSE,
  sleep_hours    DOUBLE PRECISION,
  baseline       JSONB
);
CREATE INDEX IF NOT EXISTS trips_driver_started ON trips (driver_id, started_at DESC);

CREATE TABLE IF NOT EXISTS windows (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  ts      TIMESTAMPTZ NOT NULL,
  raw     JSONB NOT NULL,
  levels  JSONB NOT NULL,
  score   DOUBLE PRECISION NOT NULL,
  tier    SMALLINT NOT NULL,
  result  JSONB NOT NULL, -- full response object, served by GET /trips/{id}/state
  PRIMARY KEY (trip_id, ts)
);

CREATE TABLE IF NOT EXISTS events (
  id       BIGSERIAL PRIMARY KEY,
  trip_id  TEXT NOT NULL REFERENCES trips(id),
  ts       TIMESTAMPTZ NOT NULL,
  tier     SMALLINT NOT NULL,
  actions  JSONB NOT NULL,
  override TEXT
);
CREATE INDEX IF NOT EXISTS events_trip_ts ON events (trip_id, ts);
`;
