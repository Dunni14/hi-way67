// TimescaleDB-only setup, applied best-effort at boot (`PgRiskStore.migrateTimescale`). Plain Postgres and
// PGlite have no extension, so none of this runs there and the tables stay ordinary tables.
// `sql/01_schema.sql` is the reference for the first block, `sql/03_policies.sql` for compression and the
// observations retention. Every statement is idempotent. Run one at a time: continuous aggregates
// cannot be created inside a transaction block.
//
// Retention: raw vitals (`windows`) and facial cues (`observations`) are dropped after 7 days. Trips,
// events, report cards, the decision log and the continuous aggregates stay.
export const TIMESCALE_SQL: string[] = [
  `SELECT create_hypertable('windows', 'ts', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE, migrate_data => TRUE)`,
  `SELECT create_hypertable('events', 'ts', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE, migrate_data => TRUE)`,
  `SELECT create_hypertable('observations', 'ts', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE, migrate_data => TRUE)`,
  `SELECT create_hypertable('decision_log', 'ts', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE, migrate_data => TRUE)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS windows_30s
   WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
   SELECT time_bucket(INTERVAL '30 seconds', ts) AS bucket, trip_id, driver_id,
     avg(heart_rate) AS heart_rate, avg(breathing_rate) AS breathing_rate, avg(drowsy) AS drowsy,
     avg(agitated) AS agitated, avg(speeding) AS speeding, avg(score) AS score, max(tier) AS max_tier
   FROM windows GROUP BY bucket, trip_id, driver_id WITH NO DATA`,
  `SELECT add_continuous_aggregate_policy('windows_30s', start_offset => INTERVAL '10 minutes',
     end_offset => INTERVAL '30 seconds', schedule_interval => INTERVAL '30 seconds', if_not_exists => TRUE)`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS trip_summary_5m
   WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
   SELECT time_bucket(INTERVAL '5 minutes', ts) AS bucket, trip_id, driver_id,
     avg(score) AS avg_score, max(score) AS max_score,
     count(*) FILTER (WHERE tier = 0) AS windows_tier0, count(*) FILTER (WHERE tier = 1) AS windows_tier1,
     count(*) FILTER (WHERE tier = 2) AS windows_tier2, count(*) FILTER (WHERE tier = 3) AS windows_tier3,
     avg(drowsy) AS avg_drowsy, sum(hard_brakes) AS hard_brakes, sum(swerves) AS swerves
   FROM windows GROUP BY bucket, trip_id, driver_id WITH NO DATA`,
  `SELECT add_continuous_aggregate_policy('trip_summary_5m', start_offset => INTERVAL '1 hour',
     end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE)`,

  `SELECT add_retention_policy('windows', INTERVAL '7 days', if_not_exists => TRUE)`,
  `SELECT add_retention_policy('observations', INTERVAL '7 days', if_not_exists => TRUE)`,

  `ALTER TABLE windows SET (timescaledb.compress, timescaledb.compress_segmentby = 'trip_id', timescaledb.compress_orderby = 'ts DESC')`,
  `SELECT add_compression_policy('windows', INTERVAL '1 day', if_not_exists => TRUE)`,
  `ALTER TABLE observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'trip_id', timescaledb.compress_orderby = 'ts DESC')`,
  `SELECT add_compression_policy('observations', INTERVAL '1 day', if_not_exists => TRUE)`,
  // Rewards arrive from later feedback, so keep decision_log writable for a week before compressing.
  `ALTER TABLE decision_log SET (timescaledb.compress, timescaledb.compress_segmentby = 'trip_id', timescaledb.compress_orderby = 'ts DESC')`,
  `SELECT add_compression_policy('decision_log', INTERVAL '7 days', if_not_exists => TRUE)`,
];
