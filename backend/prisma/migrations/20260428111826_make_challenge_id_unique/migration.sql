-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "zkp";

-- CreateEnum
CREATE TYPE "auth"."UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_VERIFY');

-- CreateEnum
CREATE TYPE "auth"."RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "auth"."ChallengeStatus" AS ENUM ('PENDING', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "auth"."StepUpResolution" AS ENUM ('PASSED', 'FAILED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "zkp"."CredentialStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "auth"."users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "public_key" BYTEA NOT NULL,
    "commitment_hash" TEXT NOT NULL,
    "status" "auth"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "last_login_at" TIMESTAMPTZ,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "device_fingerprint" TEXT,
    "ip_address" TEXT,
    "risk_level" "auth"."RiskLevel" NOT NULL DEFAULT 'LOW',
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "device_label" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."zkp_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "nonce" BYTEA NOT NULL,
    "status" "auth"."ChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,

    CONSTRAINT "zkp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."nullifiers" (
    "nullifier_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "challenge_id" UUID,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nullifiers_pkey" PRIMARY KEY ("nullifier_hash")
);

-- CreateTable
CREATE TABLE "auth"."step_up_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trigger_reason" TEXT NOT NULL,
    "risk_score" DECIMAL(5,4),
    "resolved_at" TIMESTAMPTZ,
    "resolution" "auth"."StepUpResolution",
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_up_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "argon2_salt" BYTEA NOT NULL,
    "is_used" BOOLEAN NOT NULL DEFAULT false,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMPTZ,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zkp"."credential_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "attribute_schema" JSONB NOT NULL,
    "circuit_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zkp"."credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "credential_type_id" UUID NOT NULL,
    "merkle_root" TEXT NOT NULL,
    "attribute_count" INTEGER NOT NULL,
    "status" "zkp"."CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "revocation_reason" TEXT,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zkp"."credential_leaves" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "credential_id" UUID NOT NULL,
    "leaf_index" INTEGER NOT NULL,
    "attribute_name" TEXT NOT NULL,
    "leaf_hash" TEXT NOT NULL,
    "salt" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zkp"."verification_keys" (
    "circuit_id" TEXT NOT NULL,
    "vkey_json" JSONB NOT NULL,
    "curve" TEXT NOT NULL DEFAULT 'bn254',
    "protocol" TEXT NOT NULL DEFAULT 'groth16',
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_keys_pkey" PRIMARY KEY ("circuit_id")
);

-- CreateTable
CREATE TABLE "zkp"."disclosure_proofs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "credential_id" UUID NOT NULL,
    "verifier_id" TEXT NOT NULL,
    "claimed_predicate" TEXT NOT NULL,
    "proof_valid" BOOLEAN NOT NULL,
    "verified_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "proof_metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "disclosure_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_public_key_key" ON "auth"."users"("public_key");

-- CreateIndex
CREATE UNIQUE INDEX "users_commitment_hash_key" ON "auth"."users"("commitment_hash");

-- CreateIndex
CREATE INDEX "users_commitment_hash_idx" ON "auth"."users"("commitment_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "auth"."sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "auth"."sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "auth"."sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "zkp_challenges_nonce_key" ON "auth"."zkp_challenges"("nonce");

-- CreateIndex
CREATE INDEX "zkp_challenges_nonce_idx" ON "auth"."zkp_challenges"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "nullifiers_challenge_id_key" ON "auth"."nullifiers"("challenge_id");

-- CreateIndex
CREATE INDEX "nullifiers_user_id_idx" ON "auth"."nullifiers"("user_id");

-- CreateIndex
CREATE INDEX "step_up_events_session_id_idx" ON "auth"."step_up_events"("session_id");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "auth"."recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "credential_types_name_key" ON "zkp"."credential_types"("name");

-- CreateIndex
CREATE INDEX "credentials_user_id_idx" ON "zkp"."credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_user_id_credential_type_id_key" ON "zkp"."credentials"("user_id", "credential_type_id");

-- CreateIndex
CREATE INDEX "credential_leaves_credential_id_idx" ON "zkp"."credential_leaves"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "credential_leaves_credential_id_leaf_index_key" ON "zkp"."credential_leaves"("credential_id", "leaf_index");

-- CreateIndex
CREATE INDEX "disclosure_proofs_credential_id_idx" ON "zkp"."disclosure_proofs"("credential_id");

-- AddForeignKey
ALTER TABLE "auth"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."nullifiers" ADD CONSTRAINT "nullifiers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."nullifiers" ADD CONSTRAINT "nullifiers_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "auth"."zkp_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."step_up_events" ADD CONSTRAINT "step_up_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth"."sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."step_up_events" ADD CONSTRAINT "step_up_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zkp"."credential_types" ADD CONSTRAINT "credential_types_circuit_id_fkey" FOREIGN KEY ("circuit_id") REFERENCES "zkp"."verification_keys"("circuit_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zkp"."credentials" ADD CONSTRAINT "credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zkp"."credentials" ADD CONSTRAINT "credentials_credential_type_id_fkey" FOREIGN KEY ("credential_type_id") REFERENCES "zkp"."credential_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zkp"."credential_leaves" ADD CONSTRAINT "credential_leaves_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "zkp"."credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zkp"."disclosure_proofs" ADD CONSTRAINT "disclosure_proofs_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "zkp"."credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
