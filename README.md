# ZK-Auth

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white"/>
  <img src="https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript&logoColor=white"/>
  <img src="https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white"/>
  <img src="https://img.shields.io/badge/Flutter-3.22-02569B?style=flat-square&logo=flutter&logoColor=white"/>
  <img src="https://img.shields.io/badge/TensorFlow-2.16-FF6F00?style=flat-square&logo=tensorflow&logoColor=white"/>
  <img src="https://img.shields.io/badge/Circom-2.1.6-6C3483?style=flat-square"/>
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square"/>
</p>

<p align="center">
  <strong>Enterprise-grade passwordless authentication combining Zero-Knowledge Proofs, Selective Attribute Disclosure, and LSTM Behavioral Biometrics.</strong>
</p>

<p align="center">
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#api-reference">API Reference</a> ·
  <a href="#security-model">Security Model</a> ·
  <a href="#database-design">Database Design</a> ·
  <a href="#zkp-circuits">ZKP Circuits</a> ·
  <a href="#environment-variables">Environment Variables</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## What Is ZK-Auth?

ZK-Auth is a production-ready authentication platform that eliminates passwords entirely. Instead of storing or transmitting credentials, it uses **Groth16 zero-knowledge proofs** to mathematically prove identity without exposing secrets, **Poseidon Merkle trees** for selective attribute disclosure (prove `clearance >= 3` without revealing the actual clearance level), and a real-time **LSTM neural network** that continuously scores behavioural telemetry to detect session hijacking and trigger adaptive re-authentication.

**Research basis:** Built on the paper *"Zero-Knowledge Proof for Authentication in Cloud Computing"* — accepted at FrontSci 2025 (Springer Nature).

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                                │
│   Next.js Web (WASM prover)   Flutter Mobile (Dart isolate prover) │
└───────────────────────┬──────────────────────────┬─────────────────┘
                        │ HTTPS / WSS              │ HTTPS / WSS
                        ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│               API GATEWAY  ·  Node.js / TypeScript                  │
│  /auth/*   /credential/*   /session/*   WS:/session/telemetry       │
│                                                                     │
│   ZKP Service   │   Credential Service   │   Session + Risk Service │
│   (SnarkJS)     │   (Merkle + Poseidon)  │   (JWT + Redis cache)    │
└────┬────────────┴────────┬───────────────┴──────────────┬───────────┘
     │                     │                              │
┌────▼──────┐  ┌───────────▼──────┐  ┌────────────────────▼──────────┐
│PostgreSQL │  │   TimescaleDB    │  │  Redis 7                      │
│auth + zkp │  │   telemetry      │  │  sessions · nullifiers        │
│  schemas  │  │   hypertables    │  │  nonces · risk scores         │
└───────────┘  └──────────────────┘  └──────────────────┬────────────┘
                                                         │ gRPC / mTLS
                                              ┌──────────▼────────────┐
                                              │  Python ML Service    │
                                              │  LSTM · Predictor     │
                                              │  SlidingWindow · EMA  │
                                              └───────────────────────┘
```

### Three-Pillar Authentication

| Pillar | Technology | Protocol |
|--------|-----------|---------|
| **ZKP Login** | Circom + SnarkJS — Groth16 on BN254 | Client generates proof off-chain; server verifies with in-memory vKey |
| **Selective Disclosure** | Poseidon Merkle tree (depth 8, 256 leaves) + Groth16 disclosure circuit | Proves predicate on one attribute without revealing other attributes or the tree |
| **Behavioral Biometrics** | LSTM (128→64 units) + EMA smoothing + gRPC bidirectional stream | 50-event sliding window; scores pushed to Redis; step-up triggered at configurable thresholds |

### Authentication Flow

```
CLIENT                      GATEWAY                    DB / Cache
  │                            │
  │── POST /auth/challenge ────>│── generate 32-byte nonce
  │<─ { challenge_id, nonce } ──│── Redis SET NX EX 120
  │                            │── PG INSERT zkp_challenges
  │
  │  [Client: snarkjs.groth16.fullProve(                ]
  │  [ { nonce, secret }, auth.wasm, auth.zkey )        ]
  │  [Runs in Web Worker / Dart isolate — UI unblocked  ]
  │
  │── POST /auth/verify ───────>│── fetch challenge (Redis GET)
  │   { challenge_id,           │── nullifier pre-check (Redis SISMEMBER)
  │     proof: { pi_a/b/c },    │── snarkjs.groth16.verify(vKey, signals, proof)
  │     public_signals:         │── consume challenge (Redis DEL)
  │       [nullifier, root] }   │── register nullifier (2-phase: SADD + PG INSERT)
  │                             │── issue JWT pair (sign HS256)
  │                             │── seed session risk cache (Redis SET)
  │<─ { access_token,           │
  │     refresh_token,          │
  │     session_id }            │
  │                            │
  │── WSS /session/telemetry ──>│── JWT auth on upgrade handshake
  │   BEHAVIOR_EVENT stream     │── dual-write: gRPC stream + TimescaleDB buffer
  │<─ RISK_UPDATE / STEP_UP ────│── LSTM scores → Redis → WS push
```

### Step-Up Re-Authentication Flow

```
LSTM scores risk >= 0.75 (HIGH)
  → Gateway sets Redis step_up:{sessionId} (TTL 300s)
  → Pushes STEP_UP_REQUIRED over WebSocket to client
  → Client shows non-dismissible overlay
  → User solves a new ZKP challenge (same proof flow)
  → POST /session/step-up/resolve verifies proof
  → Clears step_up Redis key, resets riskLevel = LOW
  → Pushes STEP_UP_RESOLVED over WebSocket → overlay unmounts
  → Session continues with original JWT — no re-login required
```

---

## Quick Start

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20.0.0 | [nodejs.org](https://nodejs.org) |
| Python | 3.11 | [python.org](https://python.org) |
| Flutter | ≥ 3.22 | [flutter.dev](https://flutter.dev) |
| Docker + Compose | Latest | [docker.com](https://docker.com) |
| Circom | 2.1.6 | `npm install -g circom` |
| SnarkJS | 0.7.4 | `npm install -g snarkjs` |

---

### 1. Clone and install

```bash
git clone https://github.com/Abhi2627/ZK-Auth.git
cd ZK-Auth
npm install          # installs all workspace packages
```

---

### 2. Environment setup

```bash
# Copy example files
cp backend/.env.example  backend/.env
cp ml-service/.env.example ml-service/.env

# Generate secure random secrets (run once per secret)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Fill in `backend/.env` — see the [Environment Variables](#environment-variables) section for all required fields.

---

### 3. Start infrastructure

```bash
# Starts PostgreSQL (port 5432), TimescaleDB (port 5433), Redis (port 6379)
docker-compose up -d postgres timescaledb redis

# Verify all three are healthy
docker-compose ps
```

---

### 4. Database initialisation

```bash
cd backend

# Generate Prisma client
npm run db:generate

# Apply auth + zkp schema migrations
npm run db:migrate:dev

# Apply TimescaleDB telemetry schema (hypertables + policies)
docker exec zkauth-timescale psql \
  -U zkauth_root -d zkauth_telemetry \
  -f /docker-entrypoint-initdb.d/init_timescale.sql

# Verify TimescaleDB hypertables were created
docker exec zkauth-timescale psql \
  -U zkauth_root -d zkauth_telemetry \
  -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
# Expected output: behavior_events, risk_scores

cd ..
```

---

### 5. Compile ZKP circuits

The Circom circuits must be compiled and a trusted setup ceremony run before proof generation is possible.

```bash
cd backend

# Install circomlib dependency
npm install circomlib

# ── Auth circuit ──────────────────────────────────────────────────────────────

# Compile (produces .r1cs + _js/ witness calculator)
npm run circuit:compile:auth

# Download Hermez Powers of Tau (largest public ceremony — 2^28 constraints)
wget -O powersOfTau28_hez_final_15.ptau \
  https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_15.ptau

# Phase 2 trusted setup for auth circuit
snarkjs groth16 setup \
  circuits/auth/auth.r1cs \
  powersOfTau28_hez_final_15.ptau \
  circuits/auth/auth_0000.zkey

# Contribute entropy (use a random passphrase — more contributors = more secure)
snarkjs zkey contribute \
  circuits/auth/auth_0000.zkey \
  circuits/auth/auth.zkey \
  --name="contributor-1" -v

# Export verification key (loaded into memory by the gateway at startup)
snarkjs zkey export verificationkey \
  circuits/auth/auth.zkey \
  circuits/auth/verification_key.json

# ── Disclosure circuit ─────────────────────────────────────────────────────────

npm run circuit:compile:disclosure

snarkjs groth16 setup \
  circuits/disclosure/merkle_disclosure.r1cs \
  powersOfTau28_hez_final_15.ptau \
  circuits/disclosure/merkle_disclosure_0000.zkey

snarkjs zkey contribute \
  circuits/disclosure/merkle_disclosure_0000.zkey \
  circuits/disclosure/merkle_disclosure.zkey \
  --name="contributor-1" -v

snarkjs zkey export verificationkey \
  circuits/disclosure/merkle_disclosure.zkey \
  circuits/disclosure/verification_key.json

# ── Copy WASM files to web public directory (for browser prover) ──────────────
mkdir -p ../web/public/circuits/auth ../web/public/circuits/disclosure
cp circuits/auth/auth_js/auth.wasm             ../web/public/circuits/auth/
cp circuits/auth/auth.zkey                     ../web/public/circuits/auth/
cp circuits/disclosure/merkle_disclosure_js/merkle_disclosure.wasm \
                                               ../web/public/circuits/disclosure/
cp circuits/disclosure/merkle_disclosure.zkey  ../web/public/circuits/disclosure/

# ── Copy to Flutter assets (for mobile prover) ────────────────────────────────
mkdir -p ../mobile/assets/circuits
cp circuits/auth/auth_js/auth.wasm  ../mobile/assets/circuits/
cp circuits/auth/auth.zkey          ../mobile/assets/circuits/

cd ..
```

> ⚠️ **Production note:** For production deployments, run Phase 2 with ≥ 3 independent contributors and verify the final `.zkey` using `snarkjs zkey verify`. Store the contribution transcript for public auditability.

---

### 6. Start all services

Open four terminal windows:

```bash
# Terminal 1 — API Gateway
cd backend
npm run dev
# Listens on http://localhost:3001
# Health check: http://localhost:3001/health

# Terminal 2 — ML gRPC Service
cd ml-service
pip install -r requirements.txt
python -m src.server
# Listens on grpc://localhost:50051

# Terminal 3 — Next.js Web Client
cd web
npm install
npm run dev
# Listens on http://localhost:3000

# Terminal 4 — Flutter Mobile (optional)
cd mobile
flutter pub get
flutter run
```

---

## API Reference

All endpoints are prefixed with `/api/v1`. Access tokens are passed as `Authorization: Bearer <token>`.

### Authentication

#### `POST /auth/challenge`

Issue a ZKP challenge nonce. Call this before generating a proof.

**Request body:**
```json
{
  "commitment_hash": "12345678..."  // optional — decimal BN254 field element
}
```

**Response `200`:**
```json
{
  "challenge_id": "550e8400-e29b-41d4-a716-446655440000",
  "nonce":        "a3f2c1d8e4b7...",
  "expires_at":   1720000120000
}
```

**Errors:** `429 RATE_LIMIT_EXCEEDED` (10/min per IP)

---

#### `POST /auth/verify`

Submit a Groth16 proof. Returns a JWT pair on success.

**Request body:**
```json
{
  "challenge_id": "550e8400-e29b-41d4-a716-446655440000",
  "proof": {
    "pi_a": ["12345...", "67890...", "1"],
    "pi_b": [["111...", "222..."], ["333...", "444..."], ["1", "0"]],
    "pi_c": ["55555...", "66666...", "1"],
    "protocol": "groth16",
    "curve":    "bn254"
  },
  "public_signals": [
    "7891234567890123456789",
    "9876543210987654321098"
  ]
}
```

> `public_signals[0]` = nullifier hash = `Poseidon(secret, nonce)`  
> `public_signals[1]` = commitment root = `Poseidon(secret)`

**Response `200`:**
```json
{
  "access_token":  "eyJhbGci...",
  "refresh_token": "eyJhbGci...",
  "token_type":    "Bearer",
  "expires_in":    900,
  "session_id":    "660e8400-e29b-41d4-a716-446655441111"
}
```

**Errors:** `400 INVALID_PROOF`, `400 NULLIFIER_REPLAY`, `400 CHALLENGE_EXPIRED`, `429 RATE_LIMIT_EXCEEDED`

---

#### `POST /auth/refresh`

Rotate the refresh token. Old token is immediately invalidated.

**Request body (mobile — body JSON) or cookie (`zkauth_refresh`, HttpOnly):**
```json
{ "refresh_token": "eyJhbGci..." }
```

**Response `200`:** Same shape as `/auth/verify` response.

**Errors:** `401 TOKEN_EXPIRED`, `401 TOKEN_REVOKED`

---

#### `POST /auth/logout`

Revoke the current session or all sessions.

**Headers:** `Authorization: Bearer <access_token>`

**Request body:**
```json
{ "all_devices": false }
```

**Response `200`:**
```json
{ "message": "Logged out successfully" }
```

---

### Selective Disclosure

#### `POST /credential/issue`

Issue a Merkle-committed credential. **Requires `X-Issuer-Token` header.**

**Request body:**
```json
{
  "user_id":            "550e8400-...",
  "credential_type_id": "770e8400-...",
  "attributes": {
    "clearance_level": 4,
    "department_code": 12,
    "years_service":   7
  },
  "expires_at": "2026-12-31T23:59:59Z"
}
```

**Response `201`:**
```json
{
  "credential_id": "880e8400-...",
  "merkle_root":   "1a2b3c4d...",
  "issued_at":     "2025-01-01T00:00:00.000Z",
  "salts": {
    "clearance_level": "a3f2c1d8...",
    "department_code": "b4e3d2c1...",
    "years_service":   "c5f4e3d2..."
  },
  "leaf_hashes": {
    "clearance_level": "7e8f9a0b...",
    "department_code": "1c2d3e4f...",
    "years_service":   "5a6b7c8d..."
  }
}
```

> ⚠️ **Salts are returned once and never stored server-side.** The client must persist them securely — they are required for proof generation. If lost, the credential must be re-issued.

---

#### `POST /credential/verify-claim`

Verify a selective disclosure proof. **No authentication required** — this is a public verifier endpoint.

**Request body:**
```json
{
  "credential_id":    "880e8400-...",
  "proof":            { "pi_a": [...], "pi_b": [...], "pi_c": [...], "protocol": "groth16", "curve": "bn254" },
  "public_signals":   ["<root>", "<threshold>", "<leaf_index>"],
  "claimed_predicate": "clearance_level >= 3",
  "verifier_id":      "acme-corp-hr-system"
}
```

**Response `200` (valid proof):**
```json
{
  "valid":             true,
  "claimed_predicate": "clearance_level >= 3",
  "verified_at":       "2025-07-01T12:00:00.000Z"
}
```

**Response `200` (invalid proof — always 200 to prevent timing enumeration):**
```json
{
  "valid":             false,
  "claimed_predicate": "clearance_level >= 3",
  "verified_at":       "2025-07-01T12:00:01.000Z",
  "reason":            "Proof verification failed"
}
```

---

### Session & Step-Up

#### `GET /session/me`

**Headers:** `Authorization: Bearer <access_token>`

**Response `200`:**
```json
{
  "session_id":        "660e8400-...",
  "user_id":           "550e8400-...",
  "risk_level":        "LOW",
  "step_up_required":  false,
  "step_up_level":     null,
  "created_at":        "2025-07-01T10:00:00.000Z",
  "last_active_at":    "2025-07-01T10:30:00.000Z",
  "device_fingerprint": "abc123"
}
```

---

#### `POST /session/step-up/challenge`

Issue a fresh ZKP challenge for step-up re-authentication.  
Only callable when `step_up_required = true` for the session.

**Response `200`:** Same shape as `/auth/challenge`.

---

#### `POST /session/step-up/resolve`

Submit a ZKP proof to resolve step-up. Resets risk to LOW. **Does not issue new JWTs.**

**Request body:** Same shape as `/auth/verify`.

**Response `200`:**
```json
{ "resolved": true }
```

---

### WebSocket Telemetry

```
WSS /api/v1/session/telemetry?token=<access_token>
```

Connection is authenticated at the HTTP upgrade level. Invalid tokens receive `HTTP 401` before the WebSocket handshake completes.

**Client → Server messages:**

| `type` | `payload` | Description |
|--------|-----------|-------------|
| `BEHAVIOR_EVENT` | `BehaviorEvent` | Behavioral telemetry event |
| `PING` | `{}` | Application-level keepalive |

**Server → Client messages:**

| `type` | `payload` | Description |
|--------|-----------|-------------|
| `RISK_UPDATE` | `{ score, risk_level, risk_reason }` | After each LSTM inference window |
| `STEP_UP_REQUIRED` | `{ required_level, expires_at, session_id, risk_score }` | Step-up trigger |
| `STEP_UP_RESOLVED` | `{ session_id }` | Step-up cleared |
| `PONG` | `{}` | Response to client PING |
| `SESSION_TERMINATED` | `{}` | Server-side session revocation |

**`BehaviorEvent` schema:**
```json
{
  "session_id":     "660e8400-...",
  "timestamp_ms":   1720000000000,
  "event_type":     "MOUSE_MOVE",
  "mouse_velocity": 0.47,
  "key_dwell_ms":   null,
  "scroll_delta":   null,
  "touch_pressure": null,
  "page_context":   "a3f2c1d8e4b7...",
  "sequence_num":   42
}
```

> `page_context` is the SHA-256 of the current route — never the raw URL. Raw coordinates and key codes are never transmitted.

---

## Security Model

See [`SECURITY.md`](./SECURITY.md) for the full 8-domain audit checklist and [`ARCHITECTURE.md`](./ARCHITECTURE.md) for detailed threat modelling.

### Threat Mitigations

| ID | Threat | Mitigation | Implementation |
|----|--------|-----------|----------------|
| T1 | Replay attack | Nullifier set (append-only) | Redis `SADD` + PG RLS blocks UPDATE/DELETE on `auth.nullifiers` |
| T4 | Concurrent nullifier race | Two-phase atomic commit | Distributed lock (`SET NX`) → Redis `SADD` → PG `INSERT`; rollback on any failure |
| T5 | MITM / challenge intercept | Secret bound in circuit | Attacker with nonce but no `secret` cannot produce valid `(nullifier, root)` pair |
| T6 | Disclosure linkage | Per-attribute random salts | Each re-issuance generates fresh 32-byte salts → different leaves → different root |
| T7 | Credential root forgery | Issuer-only write + root binding | Root stored at issuance; verifier fetches it from gateway — never from client |
| T8 | ML model evasion | EMA smoothing + reverse-spike detection | `score[t] = 0.3 * raw + 0.7 * score[t-1]`; sudden score drop after HIGH flagged as `VELOCITY_SPIKE_REVERSE` |
| T9 | Model poisoning | Weak-label provenance | Training labels derived from confirmed step-up failures only; manual approval gate before promotion |
| T10 | gRPC timing side-channel | Response jitter + payload padding | Uniform [0, 50ms] sleep + `risk_reason` padded to fixed 32 chars |
| T11 | JWT theft | Short TTL + HttpOnly cookie | 15-min access token; refresh via `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth/refresh` |
| T13 | Session desync | Redis as authoritative state | Gateway reads risk from Redis on every request; PG is audit log, not hot path |
| T14 | Timing enumeration | Constant-time verification | `try/finally` pad: proof verify always takes ≥ 50ms ± 10ms jitter |

### Risk Thresholds

| Score | Level | Gateway Action |
|-------|-------|---------------|
| 0.00 – 0.44 | LOW | No action |
| 0.45 – 0.74 | MEDIUM | Log + flag session |
| 0.75 – 0.89 | HIGH | Soft step-up (re-ZKP challenge) |
| 0.90 – 1.00 | CRITICAL | Hard step-up + security alert |

---

## Database Design

### Schema Overview

```
PostgreSQL 16 (zkauth_db)
├── schema: auth
│   ├── users              — identity records (commitment_hash, no passwords)
│   ├── sessions           — JWT session tracking (refresh_token_hash)
│   ├── zkp_challenges     — ephemeral nonce audit log
│   ├── nullifiers         — APPEND-ONLY replay prevention set
│   └── step_up_events     — step-up audit trail
└── schema: zkp
    ├── credential_types   — admin-defined credential templates
    ├── credentials        — issued Merkle credentials (merkle_root)
    ├── credential_leaves  — leaf hashes + salts (NO raw attribute values)
    ├── verification_keys  — circuit vkeys (loaded into memory at startup)
    └── disclosure_proofs  — selective disclosure audit log

TimescaleDB (zkauth_telemetry)
└── schema: telemetry
    ├── behavior_events    — hypertable, chunk_interval=1h, compressed >2h
    ├── risk_scores        — hypertable, chunk_interval=1d
    ├── hourly_risk_by_user    — continuous aggregate (30min refresh)
    └── hourly_event_distribution — continuous aggregate (30min refresh)
```

### Key Design Decisions

- **Raw attribute values are never stored.** Only `Poseidon(value, salt)` and the `salt` bytes are written to `credential_leaves`.
- **Nullifiers are append-only.** PostgreSQL Row-Level Security policies use `USING (false)` to make `UPDATE` and `DELETE` categorically impossible for the API role — enforced at the database layer, not just the application layer.
- **TimescaleDB is a PostgreSQL extension** — same connection pool, same backup strategy, full SQL compatibility. No separate DB engine to manage.
- **Refresh tokens are stored as `SHA-256(token)`** — a stolen database cannot be used to replay refresh tokens.

---

## ZKP Circuits

### Auth Circuit (`circuits/auth/auth.circom`)

```
Private inputs:  secret
Public inputs:   nonce
Public outputs:  nullifier_hash = Poseidon(secret, nonce)
                 commitment_root = Poseidon(secret)

Constraint count: ~350 (Poseidon is ~8x cheaper than SHA-256 in R1CS)
Proof time (WASM, M1): ~400ms
Verification time: ~2ms (server-side, in-memory vKey)
```

### Disclosure Circuit (`circuits/disclosure/merkle_disclosure.circom`)

```
Private inputs:  leaf_value, salt, path_elements[8], path_indices[8]
Public inputs:   root, threshold, leaf_index
Predicate:       leaf_value >= threshold (GTE via LessThan comparator)

Tree depth: 8 → supports up to 256 attributes per credential
Hash: Poseidon(value, salt) at leaf; Poseidon(left, right) at internal nodes
Circuit also constrains: leaf_index bits == path_indices (prevents index spoofing)
```

---

## Environment Variables

### `backend/.env`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Runtime environment |
| `PORT` | No | `3001` | HTTP server port |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `TIMESCALE_URL` | **Yes** | — | TimescaleDB connection string |
| `REDIS_URL` | **Yes** | — | Redis connection string |
| `REDIS_PASSWORD` | **Yes** | — | Redis AUTH password |
| `JWT_ACCESS_SECRET` | **Yes** | — | HS256 key for access tokens (min 32 bytes hex) |
| `JWT_REFRESH_SECRET` | **Yes** | — | HS256 key for refresh tokens (different from access) |
| `JWT_ACCESS_EXPIRY` | No | `15m` | Access token TTL |
| `JWT_REFRESH_EXPIRY` | No | `7d` | Refresh token TTL |
| `AUTH_CIRCUIT_VKEY_PATH` | **Yes** | — | Path to `auth/verification_key.json` |
| `DISCLOSURE_CIRCUIT_VKEY_PATH` | **Yes** | — | Path to `disclosure/verification_key.json` |
| `CHALLENGE_TTL_SECONDS` | No | `120` | Nonce expiry window |
| `NULLIFIER_LOCK_TTL_SECONDS` | No | `5` | Distributed lock TTL for two-phase commit |
| `ISSUER_SECRET_TOKEN` | **Yes** | — | Static token for `X-Issuer-Token` header |
| `LSTM_GRPC_HOST` | No | `localhost` | ML service hostname |
| `LSTM_GRPC_PORT` | No | `50051` | ML service gRPC port |
| `LSTM_GRPC_INSECURE` | No | `true` | Set `false` in production (requires certs) |
| `RISK_THRESHOLD_HIGH` | No | `0.75` | Score above which soft step-up triggers |
| `RISK_THRESHOLD_CRITICAL` | No | `0.90` | Score above which hard step-up triggers |
| `CORS_ALLOWED_ORIGINS` | No | `http://localhost:3000` | Comma-separated allowed origins |

### `ml-service/.env`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRPC_PORT` | No | `50051` | gRPC server port |
| `GRPC_INSECURE` | No | `true` | Set `false` in production |
| `TIMESCALE_URL` | **Yes** | — | TimescaleDB connection (lstm role) |
| `MODEL_PATH` | No | `./models/lstm_v1/model.keras` | Path to trained Keras model |
| `SCALER_PATH` | No | `./models/lstm_v1/scaler.pkl` | Path to fitted StandardScaler |
| `MODEL_VERSION` | No | `lstm_v1` | Version label included in RiskScore responses |
| `INFERENCE_WINDOW_SIZE` | No | `50` | Events per LSTM inference window |
| `RISK_SMOOTHING_ALPHA` | No | `0.3` | EMA smoothing factor |
| `RESPONSE_JITTER_MAX_MS` | No | `50` | Max response jitter for T10 mitigation |

---

## Repository Structure

```
ZK-Auth/
├── ARCHITECTURE.md              Full system design + threat model
├── SECURITY.md                  Security audit checklist (8 domains)
├── README.md                    This file
├── docker-compose.yml           Local development orchestration
├── docker-compose.prod.yml      Production override (TLS, secrets, limits)
├── package.json                 Monorepo workspace root
│
├── packages/
│   ├── proto/                   gRPC .proto definitions
│   │   ├── behavior.proto       BehaviorAnalyzer service + messages
│   │   └── auth_common.proto    Shared message types
│   └── types/                   Shared TypeScript type definitions
│       └── src/
│           ├── auth.types.ts
│           ├── credential.types.ts
│           └── risk.types.ts
│
├── backend/                     Node.js / TypeScript API Gateway
│   ├── circuits/
│   │   ├── auth/                auth.circom + compiled artifacts
│   │   └── disclosure/          merkle_disclosure.circom + artifacts
│   ├── prisma/
│   │   ├── schema.prisma        Multi-schema (auth + zkp)
│   │   └── migrations/
│   │       ├── init_postgres.sql   RLS + roles + grants
│   │       └── init_timescale.sql  Hypertables + compression + retention
│   └── src/
│       ├── config/              env · database · redis · grpc
│       ├── services/
│       │   ├── zkp/             challenge · nullifier · zkp
│       │   ├── credential/      merkle · credential · disclosure
│       │   ├── session/         session · risk
│       │   └── telemetry/       timescaledb write path
│       ├── controllers/         auth · credential · session
│       ├── routes/              auth · credential · session
│       ├── middleware/          auth · rateLimit · riskGate · issuerRole
│       ├── websocket/           wsServer · telemetryHandler
│       ├── grpc/                behaviorClient
│       └── utils/               logger · errors · crypto
│
├── ml-service/                  Python gRPC LSTM Inference Service
│   ├── src/
│   │   ├── model/               lstm_model · feature_extractor
│   │   │                        sliding_window · model_registry
│   │   ├── inference/           predictor · risk_classifier
│   │   ├── servicer/            behavior_servicer
│   │   └── db/                  telemetry_reader
│   └── training/                train.py · evaluate.py · notebooks/
│
├── web/                         Next.js 14 Web Client
│   └── src/
│       ├── app/                 App Router pages
│       ├── contexts/            WsContext (WebSocket + subscriptions)
│       ├── components/
│       │   └── AuthFlow/        LoginForm · StepUpModal
│       └── lib/
│           ├── api.ts           Typed fetch wrapper + token store
│           ├── telemetry.ts     TelemetryProvider + rAF pipeline
│           └── zkp/             prover.ts (Web Worker) · witness.ts
│
└── mobile/                      Flutter Mobile Client
    └── lib/
        ├── core/
        │   ├── api/             http_client · auth_api
        │   ├── storage/         secure_storage (Keychain/EncryptedSharedPrefs)
        │   ├── telemetry/       event_collector · ws_telemetry
        │   └── zkp/             prover_service (Dart isolate)
        └── features/
            ├── auth/
            │   ├── bloc/        AuthBloc (events · states)
            │   └── screens/     LoginScreen · StepUpScreen
            └── dashboard/       DashboardScreen
```

---

## Production Deployment

```bash
# Create Docker secrets (run once on the Swarm manager)
echo "your-strong-db-password"   | docker secret create postgres_password -
echo "your-strong-redis-password"| docker secret create redis_password -
echo "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
                                  | docker secret create jwt_access_secret -
echo "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
                                  | docker secret create jwt_refresh_secret -
echo "your-issuer-token"          | docker secret create issuer_secret_token -

# Deploy
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Scale API gateway
docker-compose -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --scale backend=2
```

**Before going live, complete all items in [`SECURITY.md`](./SECURITY.md) §8 Pre-Production Checklist**, particularly the Hermez Phase 2 ceremony and mTLS certificate generation.

---

## Training the LSTM Model

The ML service starts with a structurally correct but untrained model (random weights) that outputs scores near 0.5. To train on real data after collecting behavioural telemetry:

```bash
cd ml-service

# Requires at least 30 days of telemetry in TimescaleDB
python -m training.train \
  --hours 720 \
  --epochs 20 \
  --batch-size 256 \
  --output models/lstm_v2/model.keras \
  --scaler-out models/lstm_v2/scaler.pkl

# Hot-swap: update MODEL_PATH + MODEL_VERSION in ml-service/.env and restart
```

Label quality improves as confirmed step-up failures accumulate in `auth.step_up_events`. Anomaly windows are labelled `1` when the session's user could not or did not resolve a step-up within the TTL.

---

## Troubleshooting

### `ZKP verification service not initialised`

The gateway started before the circuit was compiled. Ensure `verification_key.json` exists at the path specified by `AUTH_CIRCUIT_VKEY_PATH`. Run the circuit compilation steps in §5 above.

### `Challenge expired` immediately after issuing

Redis TTL clock and the application server clock are out of sync. Verify with:
```bash
docker exec zkauth-redis redis-cli -a <password> TIME
date +%s
```
Both should be within 1 second. Use NTP on the host.

### `gRPC health-check failed` on backend startup

The ML service is not reachable. Check:
```bash
docker-compose ps ml-service          # should show "healthy"
docker-compose logs ml-service        # look for startup errors
```
In local dev with `LSTM_GRPC_INSECURE=true`, ensure the port mapping `50051:50051` is active.

### `P2002 Unique constraint failed on nullifiers`

A Redis failover occurred between SADD and the PG INSERT, causing a desync. The two-phase rollback should handle this automatically. If it recurs, check Redis persistence configuration (`appendonly yes` should be set).

### TimescaleDB hypertable check fails during init

The extension may not be installed. Verify:
```bash
docker exec zkauth-timescale psql -U zkauth_root -d zkauth_telemetry \
  -c "SELECT extname FROM pg_extension WHERE extname = 'timescaledb';"
```
If empty, the image used is standard PostgreSQL, not TimescaleDB. Confirm the `docker-compose.yml` uses `timescale/timescaledb:latest-pg16`.

### Flutter: `PlatformException` on secure storage (Android)

The app requires `minSdkVersion 23` for `EncryptedSharedPreferences`. In `android/app/build.gradle`:
```gradle
defaultConfig {
    minSdkVersion 23
}
```

---

## Contributing

1. Fork the repository and create a feature branch: `git checkout -b feat/your-feature`
2. Follow the existing code style — TypeScript strict mode, Zod for all inputs, no `any` types
3. For ZKP circuit changes: document constraint counts and run `snarkjs r1cs info` to verify
4. For ML changes: include before/after AUC metrics from `training/evaluate.py`
5. Ensure `npm run typecheck` and `npm run lint` pass across all workspaces
6. Submit a pull request with a description linking to the relevant phase document

---

## Research Citation

```bibtex
@inproceedings{dandge2025zkpcloud,
  title     = {Zero-Knowledge Proof for Authentication in Cloud Computing},
  author    = {Dandge, Abhay and others},
  booktitle = {Proceedings of FrontSci 2025},
  publisher = {Springer Nature},
  year      = {2025}
}
```

---

## License

MIT — See [LICENSE](./LICENSE) file.
