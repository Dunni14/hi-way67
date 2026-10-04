// Operational tables the risk engine reads and writes. Column-for-column the same as
// backend/sql/01_schema.sql, minus the TimescaleDB parts (hypertables, continuous
// aggregates, retention), so it also runs on plain Postgres and PGlite in tests.
// Idempotent: on Tiger Data the tables already exist and this only adds windows.result.
// Statements are split on ";", so keep semicolons out of comments.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS drivers (
  driver_id        TEXT PRIMARY KEY,
  display_name     TEXT,
  sharing_mode     TEXT NOT NULL DEFAULT 'high_risk_only'
                     CHECK (sharing_mode IN ('always', 'high_risk_only', 'never')),
  has_family_voice BOOLEAN NOT NULL DEFAULT FALSE,
  weight_overrides JSONB NOT NULL DEFAULT '{}',
  profile          JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id        TEXT PRIMARY KEY,
  driver_id      TEXT NOT NULL REFERENCES drivers(driver_id),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  kids_in_car    BOOLEAN NOT NULL DEFAULT FALSE,
  low_experience BOOLEAN NOT NULL DEFAULT FALSE,
  sleep_hours    DOUBLE PRECISION,
  base_hr        DOUBLE PRECISION,
  base_br        DOUBLE PRECISION,
  grade          TEXT
);
CREATE INDEX IF NOT EXISTS trips_driver_idx ON trips (driver_id, started_at DESC);

CREATE TABLE IF NOT EXISTS windows (
  ts                    TIMESTAMPTZ NOT NULL,
  trip_id               TEXT NOT NULL,
  driver_id             TEXT NOT NULL,
  face_visible          BOOLEAN,
  heart_rate            DOUBLE PRECISION,
  breathing_rate        DOUBLE PRECISION,
  engagement            DOUBLE PRECISION,
  eye_closure_frac      DOUBLE PRECISION,
  longest_eye_closure_s DOUBLE PRECISION,
  yawns                 INT,
  emotion_stress        DOUBLE PRECISION,
  gaze_off_road_s       DOUBLE PRECISION,
  phone_in_hand         BOOLEAN,
  hard_brakes           INT,
  swerves               INT,
  speed_mph             DOUBLE PRECISION,
  speed_limit_mph       DOUBLE PRECISION,
  drowsy                DOUBLE PRECISION,
  agitated              DOUBLE PRECISION,
  speeding              DOUBLE PRECISION,
  phone                 DOUBLE PRECISION,
  distracted            DOUBLE PRECISION,
  erratic               DOUBLE PRECISION,
  score                 DOUBLE PRECISION,
  tier                  INT,
  dominant              TEXT,
  degraded              BOOLEAN NOT NULL DEFAULT FALSE,
  result                JSONB,
  PRIMARY KEY (trip_id, ts)
);
ALTER TABLE windows ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS windows_driver_idx ON windows (driver_id, ts DESC);

CREATE TABLE IF NOT EXISTS events (
  ts        TIMESTAMPTZ NOT NULL,
  trip_id   TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  tier      INT NOT NULL,
  dominant  TEXT,
  actions   TEXT[] NOT NULL,
  override  INT,
  score     DOUBLE PRECISION,
  PRIMARY KEY (trip_id, ts)
);

CREATE TABLE IF NOT EXISTS observations (
  ts               TIMESTAMPTZ NOT NULL,
  trip_id          TEXT NOT NULL,
  driver_id        TEXT NOT NULL,
  expression       TEXT NOT NULL,
  intensity        DOUBLE PRECISION NOT NULL,
  face_visible     BOOLEAN,
  stress           DOUBLE PRECISION,
  engagement       DOUBLE PRECISION,
  eye_closure_frac DOUBLE PRECISION,
  yawns            DOUBLE PRECISION,
  gaze_off_road_s  DOUBLE PRECISION,
  PRIMARY KEY (trip_id, ts)
);

CREATE TABLE IF NOT EXISTS report_cards (
  trip_id         TEXT PRIMARY KEY,
  driver_id       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  formula_version INT NOT NULL,
  score           DOUBLE PRECISION NOT NULL,
  grade           TEXT NOT NULL,
  confidence      DOUBLE PRECISION NOT NULL,
  card            JSONB NOT NULL,
  features        DOUBLE PRECISION[] NOT NULL
);
CREATE INDEX IF NOT EXISTS report_cards_driver_idx ON report_cards (driver_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bandit_events (
  ts         TIMESTAMPTZ NOT NULL,
  driver_id  TEXT NOT NULL,
  trip_id    TEXT NOT NULL,
  tier       INT NOT NULL,
  dominant   TEXT NOT NULL,
  action     TEXT NOT NULL,
  context    DOUBLE PRECISION[] NOT NULL,
  scores     JSONB NOT NULL,
  learned    BOOLEAN NOT NULL DEFAULT FALSE,
  reward     DOUBLE PRECISION,
  reward_ts  TIMESTAMPTZ,
  PRIMARY KEY (trip_id, ts)
);
`;
