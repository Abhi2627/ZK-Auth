-- CreateEnum
CREATE TYPE "zkp"."InstituteStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION');

-- CreateTable
CREATE TABLE "zkp"."institutes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "institute_type" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "website" TEXT DEFAULT '',
    "public_key_hex" TEXT NOT NULL,
    "api_key_hash" TEXT NOT NULL,
    "credential_types" JSONB NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" "zkp"."InstituteStatus" NOT NULL DEFAULT 'ACTIVE',
    "registered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMPTZ,

    CONSTRAINT "institutes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "institutes_slug_key" ON "zkp"."institutes"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "institutes_did_key" ON "zkp"."institutes"("did");

-- CreateIndex
CREATE UNIQUE INDEX "institutes_email_key" ON "zkp"."institutes"("email");

-- CreateIndex
CREATE INDEX "institutes_slug_idx" ON "zkp"."institutes"("slug");

-- CreateIndex
CREATE INDEX "institutes_email_idx" ON "zkp"."institutes"("email");
