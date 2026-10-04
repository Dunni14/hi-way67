-- Driver safety app: retention and compression for the report-card tables (TimescaleDB / Tiger Data only).
-- Run after 01_schema.sql. Safe to re-run. The app applies the same statements at boot
-- (src/risk/store/timescale.ts), so this file is for applying them by hand.

-- Raw facial cues expire with the raw vitals; the report card keeps the per-expression shares.
SELECT add_retention_policy('observations', INTERVAL '7 days', if_not_exists => TRUE);

ALTER TABLE windows SET (timescaledb.compress, timescaledb.compress_segmentby = 'trip_id', timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('windows', INTERVAL '1 day', if_not_exists => TRUE);

ALTER TABLE observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'trip_id', timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('observations', INTERVAL '1 day', if_not_exists => TRUE);

-- Rewards arrive from later feedback, so decision_log stays writable for a week before compressing.
ALTER TABLE decision_log SET (timescaledb.compress, timescaledb.compress_segmentby = 'trip_id', timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('decision_log', INTERVAL '7 days', if_not_exists => TRUE);
