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
  trip_id               TEXT PRIMARY KEY,
  driver_id             TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  formula_version       INT NOT NULL,
  score                 DOUBLE PRECISION NOT NULL,
  grade                 TEXT NOT NULL,
  confidence            DOUBLE PRECISION NOT NULL,
  provisional           BOOLEAN NOT NULL DEFAULT FALSE,
  scored_windows        INT NOT NULL DEFAULT 0,
  duration_s            INT NOT NULL DEFAULT 0,
  night_trip            BOOLEAN NOT NULL DEFAULT FALSE,
  sharing_mode          TEXT,
  mean_risk             DOUBLE PRECISION,
  p90_risk              DOUBLE PRECISION,
  max_risk              DOUBLE PRECISION,
  tier0_s               INT NOT NULL DEFAULT 0,
  tier1_s               INT NOT NULL DEFAULT 0,
  tier2_s               INT NOT NULL DEFAULT 0,
  tier3_s               INT NOT NULL DEFAULT 0,
  microsleeps           INT NOT NULL DEFAULT 0,
  distance_mi           DOUBLE PRECISION,
  avg_speed_mph         DOUBLE PRECISION,
  max_speed_mph         DOUBLE PRECISION,
  over_limit_s          INT NOT NULL DEFAULT 0,
  max_over_limit_mph    DOUBLE PRECISION,
  hard_brakes           INT NOT NULL DEFAULT 0,
  swerves               INT NOT NULL DEFAULT 0,
  phone_s               INT NOT NULL DEFAULT 0,
  yawns                 INT NOT NULL DEFAULT 0,
  longest_eye_closure_s DOUBLE PRECISION,
  gaze_off_road_s       DOUBLE PRECISION,
  degraded_s            INT NOT NULL DEFAULT 0,
  dominant_expression   TEXT,
  notify_threshold      DOUBLE PRECISION,
  care_before           DOUBLE PRECISION,
  care_after            DOUBLE PRECISION,
  card                  JSONB NOT NULL,
  series                JSONB NOT NULL,
  features              DOUBLE PRECISION[] NOT NULL
);
CREATE INDEX IF NOT EXISTS report_cards_driver_idx ON report_cards (driver_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_log (
  ts         TIMESTAMPTZ NOT NULL,
  driver_id  TEXT NOT NULL,
  trip_id    TEXT NOT NULL,
  tier       INT NOT NULL,
  dominant   TEXT NOT NULL,
  action     TEXT NOT NULL,
  context    DOUBLE PRECISION[] NOT NULL,
  scores     JSONB NOT NULL,
  reward     DOUBLE PRECISION,
  reward_ts  TIMESTAMPTZ,
  PRIMARY KEY (trip_id, ts)
);
CREATE OR REPLACE VIEW driver_scorecard AS
SELECT driver_id,
  count(*) FILTER (WHERE NOT provisional)::int AS scored_trips,
  avg(score) FILTER (WHERE NOT provisional) AS avg_score,
  avg(score) FILTER (WHERE NOT provisional AND created_at >= now() - INTERVAL '30 days') AS avg_score_30d,
  count(*) FILTER (WHERE night_trip)::int AS night_trips,
  coalesce(sum(distance_mi), 0) AS distance_mi,
  coalesce(sum(duration_s), 0)::int AS duration_s,
  max(created_at) AS last_trip_at
FROM report_cards GROUP BY driver_id;
`;
