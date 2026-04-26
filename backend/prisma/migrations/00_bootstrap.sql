-- =============================================================================
-- ZK-Auth — PostgreSQL Bootstrap Migration
-- File: 00_bootstrap.sql
-- Run BEFORE `prisma migrate deploy` to prepare schemas, extensions, roles,
-- and Row-Level Security that Prisma cannot express in schema.prisma.
-- =============================================================================

-- ─── Extensions ──────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Schemas ─────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS zkp;

-- ─── Application Roles ───────────────────────────────────────────────────────
-- Principle of least privilege: each service gets only what it needs.

-- API Gateway role: full CRUD on auth + zkp schemas
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zkauth_api_role') THEN
    CREATE ROLE zkauth_api_role LOGIN PASSWORD 'CHANGE_ME_IN_ENV';
  END IF;
END $$;

GRANT USAGE ON SCHEMA auth TO zkauth_api_role;
GRANT USAGE ON SCHEMA zkp  TO zkauth_api_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO zkauth_api_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA zkp  TO zkauth_api_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO zkauth_api_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA zkp  TO zkauth_api_role;

-- ML service role: read-only access to auth schema for training data joins
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zkauth_lstm_role') THEN
    CREATE ROLE zkauth_lstm_role LOGIN PASSWORD 'CHANGE_ME_IN_ENV';
  END IF;
END $$;

GRANT USAGE ON SCHEMA auth TO zkauth_lstm_role;
GRANT SELECT ON auth.sessions, auth.step_up_events TO zkauth_lstm_role;

-- ─── Row-Level Security: Nullifiers (append-only enforcement) ─────────────────
-- The nullifiers table must never be updated or deleted — only inserted.
-- RLS enforces this at the database layer, independent of application code.

ALTER TABLE auth.nullifiers ENABLE ROW LEVEL SECURITY;

-- Allow INSERT for the API role
CREATE POLICY nullifiers_insert_policy ON auth.nullifiers
  FOR INSERT
  TO zkauth_api_role
  WITH CHECK (true);

-- Allow SELECT for the API role (needed for nullifier checks)
CREATE POLICY nullifiers_select_policy ON auth.nullifiers
  FOR SELECT
  TO zkauth_api_role
  USING (true);

-- DENY UPDATE — no policy for UPDATE means it is implicitly denied
-- DENY DELETE — no policy for DELETE means it is implicitly denied

-- ─── Default Privileges for future tables ────────────────────────────────────
-- Ensures roles retain access after future `prisma migrate deploy` runs.

ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zkauth_api_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA zkp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zkauth_api_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT SELECT ON TABLES TO zkauth_lstm_role;
