# ZK-Auth Security Audit Checklist

## 1. Secrets & Credentials

| Check | Status | Location |
|-------|--------|----------|
| No hardcoded secrets in source | ✅ | All secrets via `env` / `process.env` only |
| `.env` excluded by `.gitignore` | ✅ | `.gitignore` line: `.env` |
| `.env.example` committed (no real values) | ✅ | `backend/.env.example`, `ml-service/.env.example` |
| JWT secrets ≥ 32 bytes | ✅ | `env.ts` Zod: `.min(32)` enforced at startup |
| Refresh tokens stored as SHA-256 hash | ✅ | `session.service.ts` — `sha256(token)` before DB write |
| DB passwords via Docker secrets in prod | ✅ | `docker-compose.prod.yml` — `POSTGRES_PASSWORD_FILE` |
| Redis password required | ✅ | `redis.ts` — `AUTH password` in command |
| No secrets in URL parameters | ✅ | All auth via Bearer header / HttpOnly cookie |
| Zkey proving keys excluded from git | ✅ | `.gitignore`: `backend/circuits/**/*.zkey` |
| ML model binaries excluded from git | ✅ | `.gitignore`: `ml-service/models/**/*.keras` |
| TLS certificates excluded from git | ✅ | `.gitignore`: `certs/`, `*.pem`, `*.crt`, `*.key` |

## 2. Input Validation

| Check | Status | Location |
|-------|--------|----------|
| All API inputs validated via Zod | ✅ | `auth.schemas.ts`, `credential.schemas.ts` |
| `.strict()` on all Zod schemas (no extra fields) | ✅ | All schema definitions |
| BN254 field element format validated before snarkjs | ✅ | `zkp.service.ts` — `isValidFieldElement()` |
| Proof object shape validated before snarkjs | ✅ | `zkp.service.ts` — `validateProofShape()` |
| UUIDs validated format | ✅ | `z.string().uuid()` in all schemas |
| SQL injection: ORM-only (no raw string interpolation) | ✅ | Prisma parameterised queries throughout |
| TimescaleDB: parameterised bulk INSERT | ✅ | `telemetry.service.ts` — `$1, $2…` placeholders |

## 3. CORS

| Check | Status | Location |
|-------|--------|----------|
| Explicit allowed origins (not `*`) | ✅ | `app.ts` — `CORS_ALLOWED_ORIGINS` env var |
| Credentials mode requires exact origin match | ✅ | `cors({ origin: fn })` — rejects unlisted origins |
| `SameSite=Strict` on refresh cookie | ✅ | `session.controller.ts` — `setRefreshCookie()` |
| `HttpOnly; Secure` on refresh cookie | ✅ | `setRefreshCookie()` — `httpOnly: true, secure: prod` |
| Refresh cookie scoped to `/api/v1/auth/refresh` | ✅ | `path: '/api/v1/auth/refresh'` |

## 4. Authentication & Session

| Check | Status | Location |
|-------|--------|----------|
| Access token TTL ≤ 15 minutes | ✅ | `JWT_ACCESS_EXPIRY=15m` |
| Refresh token rotation (one-time use) | ✅ | `session.service.ts` — `rotate()` |
| Revoked token reuse triggers all-session revocation | ✅ | `session.service.ts` — `_revokeAllForUser()` |
| Nullifier set append-only (PG RLS) | ✅ | `init_postgres.sql` — `USING (false)` policies |
| Challenge TTL enforced in Redis (120s) | ✅ | `challenge.service.ts` — `'EX', CHALLENGE_TTL` |
| Constant-time proof verification (T14) | ✅ | `zkp.service.ts` — `finally` sleep pad |
| Rate limiting on all auth endpoints | ✅ | `rateLimit.middleware.ts` |
| Step-up required flag blocks all protected routes | ✅ | `riskGate.middleware.ts` |

## 5. ZKP Cryptography

| Check | Status | Location |
|-------|--------|----------|
| Groth16 on BN254 (non-malleable) | ✅ | `auth.circom`, `zkp.service.ts` |
| Poseidon hash (SNARK-optimised) | ✅ | Both circuits |
| Hermez Powers of Tau ceremony | ⚠️  | Ceremony must be executed before production deploy |
| vKey loaded once at startup (no disk I/O on hot path) | ✅ | `zkpService.initialize()` in `index.ts` |
| Per-attribute random salts (T6) | ✅ | `credential.service.ts` — `generateNonce(32)` per leaf |
| Disclosure proof root binding | ✅ | `disclosure.service.ts` — root match before verify |

## 6. ML Service

| Check | Status | Location |
|-------|--------|----------|
| gRPC mTLS in production | ✅ | `docker-compose.prod.yml`, `grpc.ts` |
| Response jitter (T10) | ✅ | `predictor.py` — `_apply_jitter()` |
| Payload padding (T10) | ✅ | `behavior_servicer.py` — `_pad_reason()` |
| EMA smoothing (T8 evasion resistance) | ✅ | `predictor.py` — alpha=0.3 |
| Sliding window memory bounded (maxlen=50) | ✅ | `sliding_window.py` |
| Orphan window reaper thread | ✅ | `WindowRegistry._reaper_loop()` |

## 7. Infrastructure

| Check | Status | Location |
|-------|--------|----------|
| Helmet security headers | ✅ | `app.ts` |
| All services non-root user in Docker | ✅ | All Dockerfiles — `USER nodeuser` / `USER mluser` |
| Production network `internal: true` (no public access except nginx) | ✅ | `docker-compose.prod.yml` |
| Named Docker volumes (data survives container removal) | ✅ | `docker-compose.prod.yml` |
| TimescaleDB data retention policy (30d behavior, 90d risk) | ✅ | `init_timescale.sql` |
| Redis persistence (`appendonly yes` + `save` policy) | ✅ | `docker-compose.prod.yml` |

## 8. Pre-Production Checklist (manual steps)

- [ ] Run Hermez Phase 2 ceremony for `auth.circom` and `merkle_disclosure.circom`
- [ ] Generate production TLS certificates (Let's Encrypt or internal CA)
- [ ] Generate mTLS client/server certs for backend ↔ ml-service gRPC
- [ ] Set all Docker secrets via `docker secret create`
- [ ] Configure `CORS_ALLOWED_ORIGINS` to exact production domain
- [ ] Set `LSTM_GRPC_INSECURE=false` in production env
- [ ] Verify `init_timescale.sql` applied and hypertable check passes
- [ ] Run `prisma migrate deploy` against production DB
- [ ] Verify nullifier RLS policies active: `SELECT * FROM pg_policies WHERE tablename='nullifiers'`
- [ ] Conduct load test: verify rate limiter thresholds under traffic
- [ ] Review and rotate all generated secrets before go-live
