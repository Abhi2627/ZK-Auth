# ZK-Auth

**Enterprise-grade passwordless authentication using Zero-Knowledge Proofs, Selective Disclosure, and LSTM Behavioral Biometrics.**

---

## Architecture

Three-pillar authentication system:

| Pillar | Technology | Purpose |
|--------|-----------|---------|
| **ZKP Authentication** | Circom / SnarkJS (Groth16 / BN254) | Passwordless login — proves knowledge of secret without revealing it |
| **Selective Disclosure** | Poseidon Merkle tree + Groth16 circuit | Reveals only that an attribute satisfies a predicate (e.g. `clearance >= 3`) |
| **Behavioral Biometrics** | LSTM (TensorFlow/Keras) + gRPC | Continuous risk scoring from interaction patterns; triggers step-up auth |

**Stack:**
- Backend: Node.js / TypeScript (Express 5, Prisma, ioredis)
- Databases: PostgreSQL 16 (auth + ZKP schemas), TimescaleDB (telemetry), Redis 7
- ML Service: Python 3.11 (gRPC, TensorFlow/Keras)
- Web: Next.js 14 (App Router, React 18)
- Mobile: Flutter 3.22 (BLoC, flutter_js, sensors_plus)

---

## Prerequisites

- Node.js ≥ 20
- Python 3.11
- Flutter ≥ 3.22
- Docker + Docker Compose
- Circom 2.1.6 (`npm install -g circom`)

---

## Local Development

### 1. Clone and install

```bash
git clone https://github.com/Abhi2627/ZK-Auth.git
cd ZK-Auth
npm install
```

### 2. Environment setup

```bash
cp backend/.env.example backend/.env
cp ml-service/.env.example ml-service/.env
# Edit both files — fill in DB passwords, JWT secrets, etc.
# Generate secrets:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Start infrastructure

```bash
docker-compose up -d postgres timescaledb redis
```

### 4. Database initialisation

```bash
cd backend

# Apply Prisma schema (auth + zkp schemas)
npx prisma migrate dev --name init

# Apply TimescaleDB migration
docker exec zkauth-timescale psql -U zkauth_root -d zkauth_telemetry \
  -f /docker-entrypoint-initdb.d/init_timescale.sql

# Generate Prisma client
npx prisma generate
```

### 5. Compile ZKP circuits (requires Circom)

```bash
cd backend

# Install circomlib
npm install circomlib

# Compile auth circuit
npm run circuit:compile:auth

# Compile disclosure circuit  
npm run circuit:compile:disclosure

# Run trusted setup (dev: use existing Powers of Tau)
# Download: wget https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_15.ptau

snarkjs groth16 setup circuits/auth/auth.r1cs powersOfTau28_hez_final_15.ptau circuits/auth/auth_0000.zkey
snarkjs zkey contribute circuits/auth/auth_0000.zkey circuits/auth/auth.zkey --name="dev"
snarkjs zkey export verificationkey circuits/auth/auth.zkey circuits/auth/verification_key.json

# Repeat for disclosure circuit
```

### 6. Start services

```bash
# Backend
cd backend && npm run dev

# ML service
cd ml-service
pip install -r requirements.txt
python -m src.server

# Web
cd web && npm run dev

# Mobile
cd mobile && flutter run
```

---

## Production Deployment

```bash
# Build and start all services
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Scale backend replicas
docker-compose -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --scale backend=2
```

See `SECURITY.md` for the full pre-production checklist.

---

## API Reference

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/auth/challenge` | Issue ZKP challenge nonce |
| POST | `/api/v1/auth/verify` | Submit Groth16 proof, receive JWTs |
| POST | `/api/v1/auth/refresh` | Rotate refresh token |
| POST | `/api/v1/auth/logout` | Revoke session |

### Selective Disclosure

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/credential/issue` | Issue Merkle credential (Issuer role) |
| POST | `/api/v1/credential/verify-claim` | Verify selective disclosure proof |
| POST | `/api/v1/credential/revoke` | Revoke credential |
| GET  | `/api/v1/credential/:id` | Fetch credential metadata |

### Session & Step-Up

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/api/v1/session/me` | Current session state |
| POST | `/api/v1/session/step-up/challenge` | Issue step-up challenge |
| POST | `/api/v1/session/step-up/resolve` | Resolve step-up with ZKP proof |
| DELETE | `/api/v1/session/:id` | Revoke specific session |
| DELETE | `/api/v1/session/all` | Revoke all sessions |

### WebSocket

```
WSS /api/v1/session/telemetry?token=<JWT>
```

**Client → Server:** `BEHAVIOR_EVENT`, `PING`  
**Server → Client:** `RISK_UPDATE`, `STEP_UP_REQUIRED`, `STEP_UP_RESOLVED`, `PONG`

---

## Security Model

See `SECURITY.md` and `ARCHITECTURE.md` for the full threat model and mitigations.

Key mitigations implemented:

| Threat | Mitigation |
|--------|-----------|
| T1 Replay | Nullifier set (Redis SADD + PG append-only RLS) |
| T4 Race condition | Distributed lock + two-phase commit |
| T5 MITM | Challenge nonce + secret binding in circuit |
| T6 Linkage | Per-attribute random salts; root re-randomised on re-issue |
| T8 ML Evasion | EMA smoothing (α=0.3); reverse-spike detector |
| T10 Side-channel | Response jitter (0–50ms) + payload padding |
| T14 Timing enum | Constant-time proof verification (50ms ± 10ms) |

---

## Repository Structure

```
ZK-Auth/
├── ARCHITECTURE.md        Phase 1 design document
├── SECURITY.md            Security audit checklist
├── docker-compose.yml     Local development
├── docker-compose.prod.yml Production override
├── packages/
│   ├── proto/             gRPC .proto definitions
│   └── types/             Shared TypeScript types
├── backend/               Node.js API gateway
│   ├── circuits/          Circom ZKP circuits
│   ├── prisma/            Schema + migrations
│   └── src/               Application source
├── ml-service/            Python gRPC LSTM service
│   ├── src/               Application source
│   └── training/          Offline training pipeline
├── web/                   Next.js web client
└── mobile/                Flutter mobile client
```

---

## License

MIT — See LICENSE file.
