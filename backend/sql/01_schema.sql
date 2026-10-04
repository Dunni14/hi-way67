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
  profile          jsonb NOT NULL DEFAULT '{}',   -- {careIndex, scoredTrips, learnedShift}, see risk/profile.ts
  share_location   boolean NOT NULL DEFAULT true, -- false: no lat/lon ever reaches the iMessage agent
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
  -- GPS-derived inputs (see gps/features.ts). Raw fixes live in gps_samples.
  gps_speeding          double precision,   -- 0..1, set whenever the client sent a gps field
  gps_erratic           double precision,   -- 0..1
  gps_stopped           boolean,            -- good GPS and under the stop speed
  limit_source          text,               -- osm, fallback or none
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
-- Databases created before GPS support: CREATE TABLE IF NOT EXISTS above does not add columns.
ALTER TABLE windows ADD COLUMN IF NOT EXISTS gps_speeding double precision;
ALTER TABLE windows ADD COLUMN IF NOT EXISTS gps_erratic double precision;
ALTER TABLE windows ADD COLUMN IF NOT EXISTS gps_stopped boolean;
ALTER TABLE windows ADD COLUMN IF NOT EXISTS limit_source text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS share_location boolean NOT NULL DEFAULT true;

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

-- One expression label per 10 s window (calm, neutral, stressed, drowsy, distracted, no_face).
CREATE TABLE IF NOT EXISTS observations (
  ts               timestamptz NOT NULL,
  trip_id          text NOT NULL,
  driver_id        text NOT NULL,
  expression       text NOT NULL,
  intensity        double precision NOT NULL,   -- 0..1
  face_visible     boolean,
  stress           double precision,
  engagement       double precision,
  eye_closure_frac double precision,
  yawns            double precision,
  gaze_off_road_s  double precision,
  PRIMARY KEY (trip_id, ts)
);
SELECT create_hypertable('observations', 'ts',
  chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

-- One report card per ended trip. `features` is the fixed-order vector named in card.feature_names.
CREATE TABLE IF NOT EXISTS report_cards (
  trip_id               text PRIMARY KEY,
  driver_id             text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  formula_version       int NOT NULL,
  score                 double precision NOT NULL,
  grade                 text NOT NULL,
  confidence            double precision NOT NULL,
  provisional           boolean NOT NULL DEFAULT FALSE,
  scored_windows        int NOT NULL DEFAULT 0,
  duration_s            int NOT NULL DEFAULT 0,
  night_trip            boolean NOT NULL DEFAULT FALSE,
  sharing_mode          text,
  mean_risk             double precision,
  p90_risk              double precision,
  max_risk              double precision,
  tier0_s               int NOT NULL DEFAULT 0,
  tier1_s               int NOT NULL DEFAULT 0,
  tier2_s               int NOT NULL DEFAULT 0,
  tier3_s               int NOT NULL DEFAULT 0,
  microsleeps           int NOT NULL DEFAULT 0,
  distance_mi           double precision,
  avg_speed_mph         double precision,
  max_speed_mph         double precision,
  over_limit_s          int NOT NULL DEFAULT 0,
  max_over_limit_mph    double precision,
  hard_brakes           int NOT NULL DEFAULT 0,
  swerves               int NOT NULL DEFAULT 0,
  phone_s               int NOT NULL DEFAULT 0,
  yawns                 int NOT NULL DEFAULT 0,
  longest_eye_closure_s double precision,
  gaze_off_road_s       double precision,
  degraded_s            int NOT NULL DEFAULT 0,
  dominant_expression   text,
  notify_threshold      double precision,
  care_before           double precision,
  care_after            double precision,
  card                  jsonb NOT NULL,
  series                jsonb NOT NULL,
  features              double precision[] NOT NULL
);
CREATE INDEX IF NOT EXISTS report_cards_driver_idx ON report_cards (driver_id, created_at DESC);

-- Per-driver rollup of report_cards (a plain view, so it works on any Postgres).
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

-- Every window where the engine took an action: 8-number context, the most severe action, the notify
-- threshold used, and the driver's feedback as reward (+1 / -1). Separate from bandit_events, which the
-- LinUCB bandit owns and trains on.
CREATE TABLE IF NOT EXISTS decision_log (
  ts         timestamptz NOT NULL,
  driver_id  text NOT NULL,
  trip_id    text NOT NULL,
  tier       int NOT NULL,
  dominant   text NOT NULL,
  action     text NOT NULL,
  context    double precision[] NOT NULL,   -- 6 levels, kids_in_car, low_experience
  scores     jsonb NOT NULL,
  reward     double precision,
  reward_ts  timestamptz,
  PRIMARY KEY (trip_id, ts)
);
SELECT create_hypertable('decision_log', 'ts',
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
  false_alarm boolean NOT NULL DEFAULT false,   -- set by src/bandit/store.ts markFalseAlarm
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

-- Phone GPS fixes that passed the accuracy and speed checks, written only during an active trip.
-- Each fix carries the window's posted limit. accel_mps2 and heading_rate_dps are against the previous
-- fix of the same window (heading only above the heading speed), filled in by the app so the 10 s
-- aggregate below can take their max. Raw fixes expire after 7 days (retention policy at the end).
CREATE TABLE IF NOT EXISTS gps_samples (
  time             timestamptz NOT NULL,
  trip_id          text NOT NULL,
  driver_id        text NOT NULL,
  lat              double precision NOT NULL,
  lon              double precision NOT NULL,
  speed_mps        real,
  heading_deg      real,
  h_accuracy_m     real,
  accel_mps2       real,
  heading_rate_dps real,
  limit_mps        real,
  limit_source     text               -- osm, fallback or none
);
SELECT create_hypertable('gps_samples', 'time',
  chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS gps_samples_trip_idx ON gps_samples (trip_id, time DESC);

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

-- 10 s GPS rollup, one row per signal window. A continuous aggregate cannot take a median or a
-- difference between consecutive rows, so speed_avg_mps is a mean (the app scores on the median) and
-- accel and heading rate are the max of the per-fix columns. gps_ok is fixes >= 3.
CREATE MATERIALIZED VIEW IF NOT EXISTS gps_10s
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '10 seconds', time) AS bucket,
  trip_id,
  driver_id,
  avg(speed_mps)        AS speed_avg_mps,
  max(speed_mps)        AS speed_max_mps,
  max(accel_mps2)       AS accel_max_mps2,
  max(heading_rate_dps) AS heading_rate_dps,
  last(lat, time)       AS lat,
  last(lon, time)       AS lon,
  count(*)              AS fixes
FROM gps_samples
GROUP BY bucket, trip_id, driver_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('gps_10s',
  start_offset      => INTERVAL '10 minutes',
  end_offset        => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists     => TRUE);

-- =====================================================================
-- PRIVACY: raw vitals expire, summaries stay
-- =====================================================================

SELECT add_retention_policy('windows', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('gps_samples', INTERVAL '7 days', if_not_exists => TRUE);
