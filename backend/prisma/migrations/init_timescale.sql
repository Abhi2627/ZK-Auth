-- =============================================================================
-- ZK-Auth TimescaleDB Initialization Migration
-- Target DB: zkauth_telemetry (TIMESCALE_URL)
-- Engine: TimescaleDB extension on PostgreSQL 16
--
-- This file is executed by Docker entrypoint on first container start.
-- For subsequent schema changes, create versioned migration files:
--   migrations/0002_add_telemetry_column.sql  etc.
--
-- Execution order matters: extension → roles → schema → tables →
-- hypertables → compression → retention → continuous aggregates → indexes.
-- =============================================================================

-- ─── 0. Extensions ───────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";         -- gen_random_uuid() fallback
CREATE EXTENSION IF NOT EXISTS pgcrypto;            -- for future encrypted columns

-- ─── 1. Roles & Permissions ───────────────────────────────────────────────────
-- Least-privilege roles. Passwords set via ALTER ROLE in a secrets-manager
-- provisioned step; placeholders here for local dev only.

DO $$
BEGIN
  -- API gateway role: INSERT on behavior_events, SELECT+INSERT on risk_scores
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zkauth_api_role') THEN
    CREATE ROLE zkauth_api_role WITH LOGIN PASSWORD 'changeme_dev_api';
  END IF;

  -- ML service role: SELECT on behavior_events (training reads), INSERT on risk_scores
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zkauth_lstm_role') THEN
    CREATE ROLE zkauth_lstm_role WITH LOGIN PASSWORD 'changeme_dev_lstm';
  END IF;
END $$;

-- ─── 2. Schema ────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS telemetry;

GRANT USAGE ON SCHEMA telemetry TO zkauth_api_role;
GRANT USAGE ON SCHEMA telemetry TO zkauth_lstm_role;

-- ─── 3. Tables ────────────────────────────────────────────────────────────────

-- ── 3a. behavior_events ───────────────────────────────────────────────────────
-- High-throughput raw behavioral event stream (write path).
-- ~500 events/sec per active user under load.
-- Time column is the partition key — always include in WHERE clauses.

CREATE TABLE IF NOT EXISTS telemetry.behavior_events (
    -- Partition key (required first for hypertable)
    time              TIMESTAMPTZ       NOT NULL,

    -- Session / user context
    session_id        UUID              NOT NULL,
    user_id           UUID              NOT NULL,

    -- Event classification
    event_type        TEXT              NOT NULL
                        CHECK (event_type IN (
                          'MOUSE_MOVE', 'KEY_DOWN', 'KEY_UP',
                          'SCROLL', 'TOUCH', 'FOCUS_LOSS'
                        )),

    -- Feature dimensions fed to LSTM
    mouse_velocity    NUMERIC(8, 4),                  -- px/ms; NULL for non-mouse events
    key_dwell_ms      INTEGER,                        -- key hold duration ms
    scroll_delta      NUMERIC(8, 4),                  -- absolute scroll units
    touch_pressure    NUMERIC(5, 4)                   -- 0.0–1.0; NULL on desktop
                        CHECK (touch_pressure IS NULL OR (touch_pressure >= 0 AND touch_pressure <= 1)),

    -- Context
    page_context      TEXT,                           -- SHA-256 hash of route — no raw PII

    -- Monotonic sequence counter per session; gaps signal dropped events
    sequence_num      BIGINT            NOT NULL
);

-- ── 3b. risk_scores ───────────────────────────────────────────────────────────
-- Aggregated LSTM inference results materialized every ~30 seconds per session.
-- Written by the ml-service after each sliding-window inference.

CREATE TABLE IF NOT EXISTS telemetry.risk_scores (
    time              TIMESTAMPTZ       NOT NULL,
    session_id        UUID              NOT NULL,
    user_id           UUID              NOT NULL,
    risk_score        NUMERIC(5, 4)     NOT NULL
                        CHECK (risk_score >= 0 AND risk_score <= 1),
    risk_level        TEXT              NOT NULL
                        CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    model_version     TEXT              NOT NULL,
    event_window      INTEGER           NOT NULL DEFAULT 50   -- events that contributed
);

-- ─── 4. Convert to Hypertables ────────────────────────────────────────────────
-- chunk_time_interval: 1 hour for behavior_events (high write volume)
--                      1 day  for risk_scores     (lower volume)

SELECT create_hypertable(
    'telemetry.behavior_events',
    'time',
    chunk_time_interval => INTERVAL '1 hour',
    if_not_exists       => TRUE
);

SELECT create_hypertable(
    'telemetry.risk_scores',
    'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists       => TRUE
);

-- ─── 5. Compression Policies ─────────────────────────────────────────────────
-- Compress chunks older than 2 hours for behavior_events.
-- segmentby session_id/user_id groups related rows together for columnar storage.
-- orderby time DESC optimises recent-first range queries.

ALTER TABLE telemetry.behavior_events
    SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'session_id, user_id',
        timescaledb.compress_orderby   = 'time DESC'
    );

SELECT add_compression_policy(
    'telemetry.behavior_events',
    compress_after  => INTERVAL '2 hours',
    if_not_exists   => TRUE
);

-- Compress risk_scores chunks older than 1 day.
ALTER TABLE telemetry.risk_scores
    SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'session_id, user_id',
        timescaledb.compress_orderby   = 'time DESC'
    );

SELECT add_compression_policy(
    'telemetry.risk_scores',
    compress_after  => INTERVAL '1 day',
    if_not_exists   => TRUE
);

-- ─── 6. Retention Policies ────────────────────────────────────────────────────
-- Drop behavior_events chunks older than 30 days.
-- Adjust RETENTION_DAYS via a parameterised migration for compliance requirements.

SELECT add_retention_policy(
    'telemetry.behavior_events',
    drop_after    => INTERVAL '30 days',
    if_not_exists => TRUE
);

-- Retain risk_scores for 90 days (needed for model retraining baselines).
SELECT add_retention_policy(
    'telemetry.risk_scores',
    drop_after    => INTERVAL '90 days',
    if_not_exists => TRUE
);

-- ─── 7. Continuous Aggregates ─────────────────────────────────────────────────
-- Materialised every 30 minutes by TimescaleDB background worker.
-- Used by the LSTM training pipeline and admin dashboards.

-- 7a. Hourly risk summary per user — primary retraining input.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry.hourly_risk_by_user
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time)  AS hour,
    user_id,
    AVG(risk_score)              AS avg_risk_score,
    MAX(risk_score)              AS max_risk_score,
    MIN(risk_score)              AS min_risk_score,
    COUNT(*)                     AS score_count,
    -- Count of high-risk windows: proxy for anomaly frequency
    COUNT(*) FILTER (WHERE risk_level IN ('HIGH', 'CRITICAL')) AS high_risk_count
FROM telemetry.risk_scores
GROUP BY hour, user_id
WITH NO DATA;   -- populate on first refresh, not at creation time

-- Refresh policy: materialise last 2 hours every 30 minutes.
SELECT add_continuous_aggregate_policy(
    'telemetry.hourly_risk_by_user',
    start_offset  => INTERVAL '2 hours',
    end_offset    => INTERVAL '30 minutes',
    schedule_interval => INTERVAL '30 minutes',
    if_not_exists => TRUE
);

-- 7b. Hourly event-type distribution per user — feature drift monitoring.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry.hourly_event_distribution
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time)  AS hour,
    user_id,
    event_type,
    COUNT(*)                     AS event_count,
    AVG(mouse_velocity)          AS avg_mouse_velocity,
    AVG(key_dwell_ms)            AS avg_key_dwell_ms,
    AVG(scroll_delta)            AS avg_scroll_delta,
    AVG(touch_pressure)          AS avg_touch_pressure
FROM telemetry.behavior_events
GROUP BY hour, user_id, event_type
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'telemetry.hourly_event_distribution',
    start_offset  => INTERVAL '2 hours',
    end_offset    => INTERVAL '30 minutes',
    schedule_interval => INTERVAL '30 minutes',
    if_not_exists => TRUE
);

-- ─── 8. Indexes ───────────────────────────────────────────────────────────────
-- TimescaleDB automatically creates an index on the time column (partition key).
-- These secondary indexes cover the two most common query patterns:
--   (a) per-session recent events for the LSTM sliding window
--   (b) per-user risk score history for retraining

-- behavior_events: per-session recent window (LSTM read path)
CREATE INDEX IF NOT EXISTS idx_behavior_session_time
    ON telemetry.behavior_events (session_id, time DESC);

-- behavior_events: per-user bulk read (training pipeline)
CREATE INDEX IF NOT EXISTS idx_behavior_user_time
    ON telemetry.behavior_events (user_id, time DESC);

-- risk_scores: per-session most recent score (gateway cache fallback)
CREATE INDEX IF NOT EXISTS idx_risk_session_time
    ON telemetry.risk_scores (session_id, time DESC);

-- risk_scores: per-user history (dashboard + retraining)
CREATE INDEX IF NOT EXISTS idx_risk_user_time
    ON telemetry.risk_scores (user_id, time DESC);

-- ─── 9. Row-Level Security (telemetry schema) ─────────────────────────────────
-- Restrict the LSTM role to SELECT on behavior_events (no write).
-- Restrict the API role to INSERT on behavior_events (no SELECT of other users).
-- Full RLS for auth schema nullifiers is in the Prisma migration SQL block.

ALTER TABLE telemetry.behavior_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.risk_scores     ENABLE ROW LEVEL SECURITY;

-- API role: INSERT only (row belongs to any session — enforced at app layer)
CREATE POLICY IF NOT EXISTS behavior_events_api_insert
    ON telemetry.behavior_events
    FOR INSERT
    TO zkauth_api_role
    WITH CHECK (true);

-- LSTM role: SELECT only (read all rows for training)
CREATE POLICY IF NOT EXISTS behavior_events_lstm_select
    ON telemetry.behavior_events
    FOR SELECT
    TO zkauth_lstm_role
    USING (true);

-- LSTM role: INSERT risk scores
CREATE POLICY IF NOT EXISTS risk_scores_lstm_insert
    ON telemetry.risk_scores
    FOR INSERT
    TO zkauth_lstm_role
    WITH CHECK (true);

-- API role: SELECT risk scores (for session state)
CREATE POLICY IF NOT EXISTS risk_scores_api_select
    ON telemetry.risk_scores
    FOR SELECT
    TO zkauth_api_role
    USING (true);

-- ─── 10. Grants ───────────────────────────────────────────────────────────────

GRANT INSERT                         ON telemetry.behavior_events         TO zkauth_api_role;
GRANT SELECT                         ON telemetry.risk_scores              TO zkauth_api_role;
GRANT SELECT                         ON telemetry.hourly_risk_by_user      TO zkauth_api_role;

GRANT SELECT                         ON telemetry.behavior_events          TO zkauth_lstm_role;
GRANT INSERT                         ON telemetry.risk_scores              TO zkauth_lstm_role;
GRANT SELECT                         ON telemetry.hourly_risk_by_user      TO zkauth_lstm_role;
GRANT SELECT                         ON telemetry.hourly_event_distribution TO zkauth_lstm_role;

-- ─── 11. Seed: TimescaleDB metadata check ─────────────────────────────────────
-- Verify hypertables were created correctly. This will appear in init logs.

DO $$
DECLARE
    ht_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO ht_count
    FROM timescaledb_information.hypertables
    WHERE hypertable_schema = 'telemetry';

    IF ht_count < 2 THEN
        RAISE EXCEPTION 'TimescaleDB init failed: expected 2 hypertables, found %', ht_count;
    END IF;

    RAISE NOTICE 'TimescaleDB init complete: % hypertables verified in telemetry schema.', ht_count;
END $$;
