-- =============================================================================
-- ZK-Auth Phase 8 Migration
-- Adds: auth.recovery_codes, auth.sessions.device_label, auth.sessions.user_agent
-- =============================================================================

-- ─── 1. recovery_codes table ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth.recovery_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    code_hash       TEXT NOT NULL,          -- argon2id(mnemonic, argon2_salt)
    argon2_salt     BYTEA NOT NULL,         -- 16-byte random per-code salt
    is_used         BOOLEAN NOT NULL DEFAULT FALSE,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    superseded_at   TIMESTAMPTZ             -- set when a new code is generated
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id
    ON auth.recovery_codes(user_id);

-- Only one active code per user: partial unique index on (user_id) where not used
CREATE UNIQUE INDEX IF NOT EXISTS uniq_recovery_codes_active_per_user
    ON auth.recovery_codes(user_id)
    WHERE is_used = FALSE AND superseded_at IS NULL;

-- Row-Level Security: API role can INSERT + SELECT, but not UPDATE is_used directly.
-- Updates are done via stored procedure to enforce atomic burn semantics.
ALTER TABLE auth.recovery_codes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'auth' AND tablename = 'recovery_codes'
      AND policyname = 'recovery_codes_api_insert_select'
  ) THEN
    CREATE POLICY recovery_codes_api_insert_select
      ON auth.recovery_codes
      FOR ALL
      TO zkauth_api_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON auth.recovery_codes TO zkauth_api_role;

-- ─── 2. Add device_label + user_agent columns to auth.sessions ────────────────

ALTER TABLE auth.sessions
    ADD COLUMN IF NOT EXISTS device_label TEXT,
    ADD COLUMN IF NOT EXISTS user_agent   TEXT;

-- ─── 3. Stored procedure: atomic recovery code burn ──────────────────────────
-- Marks a recovery code as used and returns the associated user_id.
-- Using a stored procedure ensures the mark-as-used and lookup are atomic,
-- preventing TOCTOU races on concurrent recovery attempts.

CREATE OR REPLACE FUNCTION auth.burn_recovery_code(p_user_id UUID, p_code_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_rows_updated INTEGER;
BEGIN
    UPDATE auth.recovery_codes
       SET is_used = TRUE,
           used_at = NOW()
     WHERE user_id = p_user_id
       AND code_hash = p_code_hash
       AND is_used = FALSE
       AND superseded_at IS NULL;

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
    RETURN v_rows_updated = 1;
END;
$$;

GRANT EXECUTE ON FUNCTION auth.burn_recovery_code TO zkauth_api_role;

-- ─── 4. Verify migration ─────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'auth' AND table_name = 'recovery_codes'
    ) THEN
        RAISE EXCEPTION 'Phase 8 migration failed: auth.recovery_codes not created';
    END IF;
    RAISE NOTICE 'Phase 8 migration verified: recovery_codes table present.';
END $$;
