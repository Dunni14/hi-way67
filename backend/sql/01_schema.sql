-- Driver safety app: Tiger Data schema
-- Run once, top to bottom. Safe to re-run (IF NOT EXISTS everywhere).
-- Requires the timescaledb extension (pre-installed on Tiger Cloud).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- =====================================================================
-- CONFIG TABLES (small, static, seeded by 02_seed.sql)
-- =====================================================================

-- Risk equation: z = sum(weight * level). weight = ln(odds_ratio).
CREATE TABLE IF NOT EXISTS risk_factors (
  factor      text PRIMARY KEY,
  odds_ratio  double precision NOT NULL CHECK (odds_ratio > 0),
  weight      double precision GENERATED ALWAYS AS (ln(odds_ratio)) STORED,
  sub_score   text NOT NULL CHECK (sub_score IN ('drowsy', 'reckless')),
  source      text NOT NULL,
  verified    boolean NOT NULL DEFAULT false
);

-- Optional sleep term added to z when trips.sleep_hours is not null.
CREATE TABLE IF NOT EXISTS sleep_terms (
  min_hours   double precision NOT NULL,
  max_hours   double precision,              -- null = no upper bound
  odds_ratio  double precision NOT NULL CHECK (odds_ratio > 0),
  weight      double precision GENERATED ALWAYS AS (ln(odds_ratio)) STORED,
  source      text NOT NULL,
  PRIMARY KEY (min_hours)
);

-- How raw signals combine into each 0..1 level.
-- contribution = sub_weight * clamp(transform(signal) / scale, 0, 1)
CREATE TABLE IF NOT EXISTS level_components (
  level       text NOT NULL,
  signal      text NOT NULL,
  sub_weight  double precision NOT NULL,
  scale       double precision NOT NULL,
  transform   text NOT NULL CHECK (transform IN
                ('raw', 'one_minus', 'below_baseline', 'above_baseline',
                 'over_limit', 'boolean', 'sum_events')),
  PRIMARY KEY (level, signal)
);

-- Context multiplier: m = 1 + sum(k * flag).
CREATE TABLE IF NOT EXISTS context_multipliers (
  flag  text PRIMARY KEY,
  k     double precision NOT NULL
);

-- Decision tree tiers. Do not change without changing BACKEND_README.md.
CREATE TABLE IF NOT EXISTS tiers (
  tier       int PRIMARY KEY,
  min_score  double precision NOT NULL,
  max_score  double precision NOT NULL,     -- exclusive, 100.01 for top tier
  actions    text[] NOT NULL
);

-- Decision tree override rules, evaluated in priority order.
CREATE TABLE IF NOT EXISTS override_rules (
  rule_id      int PRIMARY KEY,
  description  text NOT NULL,
  signal       text NOT NULL,
  threshold    double precision,
  consecutive_windows int NOT NULL DEFAULT 1,
  effect       text NOT NULL CHECK (effect IN ('set_tier', 'min_tier', 'raise_one')),
  tier         int
);

-- Scalar settings (cap, cooldowns, bandit constants).
CREATE TABLE IF NOT EXISTS settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL,
  note   text
);

-- Recommendations the bandit can choose from.
CREATE TABLE IF NOT EXISTS bandit_actions (
  action_id    text PRIMARY KEY,
  tiers        int[] NOT NULL,
  dominant     text NOT NULL CHECK (dominant IN ('drowsy', 'reckless', 'both')),
  description  text NOT NULL,
  default_for  text[] NOT NULL DEFAULT '{}',   -- e.g. {'1:drowsy'}
  requires     text                            -- e.g. 'family_voice'
);

-- =====================================================================
-- OPERATIONAL TABLES
-- =====================================================================

CREATE TABLE IF NOT EXISTS drivers (
  driver_id        text PRIMARY KEY,
  display_name     text,
  sharing_mode     text NOT NULL DEFAULT 'high_risk_only'
                     CHECK (sharing_mode IN ('always', 'high_risk_only', 'never')),
  has_family_voice boolean NOT NULL DEFAULT false,
  weight_overrides jsonb NOT NULL DEFAULT '{}',   -- factor -> multiplier 0.5..1.5
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id        text PRIMARY KEY,
  driver_id      text NOT NULL REFERENCES drivers(driver_id),
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  kids_in_car    boolean NOT NULL DEFAULT false,
  low_experience boolean NOT NULL DEFAULT false,
  sleep_hours    double precision,
  base_hr        double precision,       -- set after first 60 s
  base_br        double precision,
  grade          text
);
CREATE INDEX IF NOT EXISTS trips_driver_idx ON trips (driver_id, started_at DESC);

-- One row per 10 s signal window. Raw inputs + computed outputs.
CREATE TABLE IF NOT EXISTS windows (
  ts                    timestamptz NOT NULL,
  trip_id               text NOT NULL,
  driver_id             text NOT NULL,
  -- raw inputs (client maps Presage SDK output into these)
  face_visible          boolean,
  heart_rate            double precision,
  breathing_rate        double precision,
  engagement            double precision,
  eye_closure_frac      double precision,
  longest_eye_closure_s double precision,
  yawns                 int,
  emotion_stress        double precision,
  gaze_off_road_s       double precision,
  phone_in_hand         boolean,
  hard_brakes           int,
  swerves               int,
  speed_mph             double precision,
  speed_limit_mph       double precision,
  -- computed levels, 0..1
  drowsy                double precision,
  agitated              double precision,
  speeding              double precision,
  phone                 double precision,
  distracted            double precision,
  erratic               double precision,
  -- computed outputs
  score                 double precision,
  tier                  int,
  dominant              text,
  degraded              boolean NOT NULL DEFAULT false,
  result                jsonb,           -- full Evaluation, served by GET /trips/{id}/state
  PRIMARY KEY (trip_id, ts)
);
SELECT create_hypertable('windows', 'ts',
  chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS windows_driver_idx ON windows (driver_id, ts DESC);

-- Every time the decision tree fires an action.
CREATE TABLE IF NOT EXISTS events (
  ts         timestamptz NOT NULL,
  trip_id    text NOT NULL,
  driver_id  text NOT NULL,
  tier       int NOT NULL,
  dominant   text,
  actions    text[] NOT NULL,
  override   int,                         -- override_rules.rule_id, if any
  score      double precision,
  PRIMARY KEY (trip_id, ts)
);
SELECT create_hypertable('events', 'ts',
  chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);

-- Bandit decisions and their rewards.
CREATE TABLE IF NOT EXISTS bandit_events (
  ts         timestamptz NOT NULL,
  driver_id  text NOT NULL,
  trip_id    text NOT NULL,
  tier       int NOT NULL,
  dominant   text NOT NULL,
  action     text NOT NULL,
  context    double precision[] NOT NULL,   -- length 8
  scores     jsonb NOT NULL,                -- p_a per allowed action
  learned    boolean NOT NULL DEFAULT false,
  reward     double precision,              -- null until computed
  reward_ts  timestamptz,
  PRIMARY KEY (trip_id, ts)
);
SELECT create_hypertable('bandit_events', 'ts',
  chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS bandit_pending_idx
  ON bandit_events (trip_id, ts) WHERE reward IS NULL;

-- LinUCB state per driver per action.
CREATE TABLE IF NOT EXISTS bandit_models (
  driver_id  text NOT NULL,
  action     text NOT NULL,
  a_matrix   double precision[] NOT NULL,   -- flattened 8x8, row-major
  b_vector   double precision[] NOT NULL,   -- length 8
  updates    int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_id, action)
);

-- =====================================================================
-- CONTINUOUS AGGREGATES
-- =====================================================================

-- 30 s rollup: live chart, /state endpoint, bandit reward before/after.
CREATE MATERIALIZED VIEW IF NOT EXISTS windows_30s
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '30 seconds', ts) AS bucket,
  trip_id,
  driver_id,
  avg(heart_rate)     AS heart_rate,
  avg(breathing_rate) AS breathing_rate,
  avg(drowsy)         AS drowsy,
  avg(agitated)       AS agitated,
  avg(speeding)       AS speeding,
  avg(score)          AS score,
  max(tier)           AS max_tier
FROM windows
GROUP BY bucket, trip_id, driver_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('windows_30s',
  start_offset      => INTERVAL '10 minutes',
  end_offset        => INTERVAL '30 seconds',
  schedule_interval => INTERVAL '30 seconds',
  if_not_exists     => TRUE);

-- Per-trip rollup: report card and long-term history.
CREATE MATERIALIZED VIEW IF NOT EXISTS trip_summary_5m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', ts) AS bucket,
  trip_id,
  driver_id,
  avg(score)                               AS avg_score,
  max(score)                               AS max_score,
  count(*) FILTER (WHERE tier = 0)         AS windows_tier0,
  count(*) FILTER (WHERE tier = 1)         AS windows_tier1,
  count(*) FILTER (WHERE tier = 2)         AS windows_tier2,
  count(*) FILTER (WHERE tier = 3)         AS windows_tier3,
  avg(drowsy)                              AS avg_drowsy,
  sum(hard_brakes)                         AS hard_brakes,
  sum(swerves)                             AS swerves
FROM windows
GROUP BY bucket, trip_id, driver_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('trip_summary_5m',
  start_offset      => INTERVAL '1 hour',
  end_offset        => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists     => TRUE);

-- =====================================================================
-- PRIVACY: raw vitals expire, summaries stay
-- =====================================================================

SELECT add_retention_policy('windows', INTERVAL '7 days', if_not_exists => TRUE);
