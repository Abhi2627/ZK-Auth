-- CreateTable
CREATE TABLE "auth"."oauth_clients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "client_secret_hash" TEXT,
    "redirect_uris" TEXT[],
    "scopes" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_authorization_codes" (
    "code" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "state" TEXT,
    "code_challenge" TEXT,
    "code_challenge_method" TEXT,
    "nullifier_hash" TEXT NOT NULL,
    "is_used" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "auth"."oauth_clients"("client_id");

-- CreateIndex
CREATE INDEX "oauth_clients_client_id_idx" ON "auth"."oauth_clients"("client_id");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_client_id_idx" ON "auth"."oauth_authorization_codes"("client_id");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_user_id_idx" ON "auth"."oauth_authorization_codes"("user_id");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_expires_at_idx" ON "auth"."oauth_authorization_codes"("expires_at");

-- AddForeignKey
ALTER TABLE "auth"."oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
