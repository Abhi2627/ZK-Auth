-- CreateEnum
CREATE TYPE "zkp"."VerificationReqStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "zkp"."issuance_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "credential_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_type" TEXT NOT NULL,
    "issuer_did" TEXT NOT NULL,
    "holder_did" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "merkle_root" TEXT NOT NULL,
    "attribute_schema" JSONB NOT NULL,
    "ip_address" TEXT,

    CONSTRAINT "issuance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zkp"."verification_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "verifier_did" TEXT NOT NULL,
    "verifier_name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "requested_claims" JSONB NOT NULL,
    "challenge" TEXT NOT NULL,
    "status" "zkp"."VerificationReqStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "responded_at" TIMESTAMPTZ,
    "approved_claims" JSONB,
    "rejected_claims" JSONB,
    "rejection_reason" TEXT,

    CONSTRAINT "verification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "issuance_records_user_id_idx" ON "zkp"."issuance_records"("user_id");

-- CreateIndex
CREATE INDEX "issuance_records_issued_at_idx" ON "zkp"."issuance_records"("issued_at");

-- CreateIndex
CREATE INDEX "verification_requests_user_id_idx" ON "zkp"."verification_requests"("user_id");

-- CreateIndex
CREATE INDEX "verification_requests_status_idx" ON "zkp"."verification_requests"("status");
