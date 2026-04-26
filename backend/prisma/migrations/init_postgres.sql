-- =============================================================================
-- ZK-Auth PostgreSQL Initialization — auth + zkp schemas
-- Executed via: prisma migrate deploy (wraps this in a Prisma migration)
-- OR manually against the PRIMARY postgres container.
--
-- This file handles:
--   1. Schema creation + extension enablement
--   2. Least-privilege role creation
--   3. Row-Level Security on auth.nullifiers (append-only enforcement)
--   4. pgcrypto column encryption marker comment on credential_leaves.salt
-- =============================================================================

-- ─── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- query performance monitoring

-- ─── Schemas ──────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS zkp;

-- ─── Roles ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zkauth_api_role') THEN
    CREATE ROLE zkauth_api_role WITH LOGIN PASSWORD 'changeme_dev_api';
  END IF;
END $$;

GRANT USAGE ON SCHEMA auth TO zkauth_api_role;
GRANT USAGE ON SCHEMA zkp  TO zkauth_api_role;

-- ─── Row-Level Security: auth.nullifiers (APPEND-ONLY) ───────────────────────
-- Applied AFTER Prisma creates the table via migration.
-- This block is idempotent — safe to re-run.

-- Enable RLS (no-op if already enabled)
ALTER TABLE IF EXISTS auth.nullifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS auth.nullifiers FORCE ROW LEVEL SECURITY;

-- Allow INSERT for the API role
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'auth' AND tablename = 'nullifiers' AND policyname = 'nullifiers_insert_only'
  ) THEN
    CREATE POLICY nullifiers_insert_only
      ON auth.nullifiers
      FOR INSERT
      TO zkauth_api_role
      WITH CHECK (true);
  END IF;
END $$;

-- Explicitly deny UPDATE and DELETE at the policy level
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'auth' AND tablename = 'nullifiers' AND policyname = 'nullifiers_no_update'
  ) THEN
    CREATE POLICY nullifiers_no_update
      ON auth.nullifiers
      FOR UPDATE
      TO zkauth_api_role
      USING (false);      -- never matches → UPDATE always rejected
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'auth' AND tablename = 'nullifiers' AND policyname = 'nullifiers_no_delete'
  ) THEN
    CREATE POLICY nullifiers_no_delete
      ON auth.nullifiers
      FOR DELETE
      TO zkauth_api_role
      USING (false);      -- never matches → DELETE always rejected
  END IF;
END $$;

-- Allow SELECT (needed for nullifier existence checks)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'auth' AND tablename = 'nullifiers' AND policyname = 'nullifiers_select'
  ) THEN
    CREATE POLICY nullifiers_select
      ON auth.nullifiers
      FOR SELECT
      TO zkauth_api_role
      USING (true);
  END IF;
END $$;

-- ─── Column comment: credential_leaves.salt encryption marker ─────────────────
-- Signals to the application layer that this column must be encrypted/decrypted
-- via pgcrypto pgp_sym_encrypt / pgp_sym_decrypt before persistence.
-- The encryption key is injected via CREDENTIAL_SALT_KEY env var (never hardcoded).

COMMENT ON COLUMN zkp.credential_leaves.salt IS
  'pgcrypto pgp_sym_encrypt encrypted 32-byte random salt. '
  'Decrypt with: pgp_sym_decrypt(salt, $CREDENTIAL_SALT_KEY). '
  'Never read or write this column without the encryption wrapper.';

-- ─── Grants (post-Prisma migration) ──────────────────────────────────────────
-- Prisma runs as the root role; we grant table-level access to the API role
-- after the migration creates the tables.

DO $$
BEGIN
  -- auth schema tables
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users') THEN
    GRANT SELECT, INSERT, UPDATE ON auth.users             TO zkauth_api_role;
    GRANT SELECT, INSERT, UPDATE ON auth.sessions          TO zkauth_api_role;
    GRANT SELECT, INSERT, UPDATE ON auth.zkp_challenges    TO zkauth_api_role;
    GRANT SELECT, INSERT         ON auth.nullifiers        TO zkauth_api_role;  -- no UPDATE/DELETE
    GRANT SELECT, INSERT, UPDATE ON auth.step_up_events    TO zkauth_api_role;

    -- zkp schema tables
    GRANT SELECT                 ON zkp.credential_types   TO zkauth_api_role;
    GRANT SELECT, INSERT, UPDATE ON zkp.credentials        TO zkauth_api_role;
    GRANT SELECT, INSERT         ON zkp.credential_leaves  TO zkauth_api_role;
    GRANT SELECT                 ON zkp.verification_keys  TO zkauth_api_role;
    GRANT SELECT, INSERT         ON zkp.disclosure_proofs  TO zkauth_api_role;
  END IF;
END $$;
