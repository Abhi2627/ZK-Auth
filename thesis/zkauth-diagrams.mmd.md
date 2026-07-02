# ZK-Auth — Mermaid Diagrams

Paste any single diagram below (the code inside a ```mermaid block) into https://mermaid.live
Each diagram is self-contained.

---

## 1. Master Architecture + Data Flow (block diagram)

```mermaid
flowchart TB
  %% ===================== CLIENTS =====================
  subgraph CLIENTS["Clients — Prover side (secret never leaves device)"]
    direction TB
    WEB["Next.js Web Client<br/>WASM prover in Web Worker"]
    MOB["Flutter Mobile Client<br/>WASM prover in hidden WebView"]
    subgraph CLIB["Client crypto"]
      SECRET["Local secret (32B)<br/>localStorage / Keychain"]
      POSC["Poseidon: commitment + nullifier"]
      GROTH["snarkjs.groth16.fullProve()"]
    end
    TELE["Telemetry capture<br/>mouse / key / scroll / touch"]
  end

  %% ===================== BACKEND =====================
  subgraph BE["Backend — OAuth 2.0 Authorization Server + Verifier (Node/Express)"]
    direction TB
    AUTHC["auth.controller<br/>register / challenge / verify / refresh / recover"]
    CHAL["challenge.service<br/>nonce issue + consume"]
    ZKP["zkp.service<br/>Groth16 verify + T14 timing pad"]
    NULL["nullifier.service<br/>T4 two-phase atomic"]
    SESS["session.service<br/>JWT issue + rotation"]
    RECOV["recovery.service<br/>BIP-39 + Argon2id"]
    OAUTH["oauth.service<br/>authorize + code + token"]
    CRED["credential.service<br/>issuance + Merkle build"]
    DISC["disclosure.service<br/>predicate proof verify"]
    RISK["risk.service<br/>step-up trigger"]
    MID["Middleware<br/>auth / riskGate / idempotency / rateLimit"]
  end

  %% ===================== DATA STORES =====================
  subgraph DS["Data Stores"]
    direction LR
    PG[("PostgreSQL<br/>users, sessions,<br/>nullifiers, challenges,<br/>credentials, oauth")]
    RD[("Redis<br/>challenge TTL,<br/>nullifier SET,<br/>session + step-up")]
    TS[("TimescaleDB<br/>behavior_events,<br/>risk_scores")]
  end

  %% ===================== ML SERVICE =====================
  subgraph ML["ML Service (Python, gRPC)"]
    direction TB
    FEAT["feature_extractor<br/>6-D normalised vector"]
    WIN["sliding_window<br/>deque maxlen=50"]
    LSTM["LSTM 128 -> 64 -> Dense<br/>sigmoid anomaly score"]
    PRED["predictor<br/>EMA smoothing (T8) + jitter (T10)"]
    CLS["risk_classifier<br/>LOW/MED/HIGH/CRITICAL"]
  end

  %% ===================== CIRCUITS =====================
  subgraph CIR["ZK Circuits (circom + Groth16, BN254)"]
    AUTHCIR["auth.circom<br/>commitment_root + nullifier_hash"]
    DISCIR["merkle_disclosure.circom<br/>depth-8 Merkle + GTE predicate"]
  end

  %% ---------- edges: auth flow ----------
  WEB --> CLIB
  MOB --> CLIB
  GROTH -. uses .-> AUTHCIR
  CLIB -->|"proof + publicSignals"| AUTHC
  AUTHC --> CHAL
  AUTHC --> ZKP
  AUTHC --> NULL
  AUTHC --> SESS
  AUTHC --> RECOV
  AUTHC --> OAUTH
  ZKP -. vKey .-> AUTHCIR
  CHAL <--> RD
  CHAL --> PG
  ZKP --> PG
  NULL <--> RD
  NULL --> PG
  SESS --> PG
  SESS --> RD

  %% ---------- edges: disclosure ----------
  WEB -->|"predicate proof"| DISC
  CRED --> DISCIR
  DISC -. vKey .-> DISCIR
  CRED --> PG
  DISC --> PG

  %% ---------- edges: behavioral ----------
  TELE -->|"WebSocket stream"| MID
  MID --> RISK
  RISK -->|"gRPC stream"| FEAT
  FEAT --> WIN --> LSTM --> PRED --> CLS
  CLS -->|"RiskScore"| RISK
  RISK --> RD
  RISK --> TS
  RISK -.->|"STEP_UP_REQUIRED (WS)"| WEB

  %% ---------- middleware gate ----------
  MID -. reads step-up .-> RD
```

---

## 2. ZK Login Flow (sequence diagram)

```mermaid
sequenceDiagram
    autonumber
    participant U as User Device (Prover)
    participant API as Backend /auth
    participant R as Redis
    participant PG as PostgreSQL
    participant VK as In-memory vKey

    Note over U: secret stored locally<br/>commitment = Poseidon(secret)

    U->>API: POST /auth/challenge {commitment?}
    API->>R: SET NX challenge:id (nonce, TTL 120s)
    API->>PG: INSERT zkp_challenge PENDING
    API-->>U: {challenge_id, nonce, expires_at}

    Note over U: witness = {nonce, secret}<br/>groth16.fullProve in Web Worker
    U->>U: proof + [nullifier, commitment, nonce]

    U->>API: POST /auth/verify {challenge_id, proof, publicSignals}
    API->>R: challenge fetch (TTL check)
    API->>R: SISMEMBER nullifiers (fast replay pre-check)
    API->>API: nonce binding check (mod field)
    API->>VK: groth16.verify(vKey, signals, proof)
    Note over API: T14 constant-time pad (>=50ms +/- jitter)
    API->>PG: find user by commitment_root
    alt user missing / suspended
        API-->>U: 400 same error (no enumeration)
    else valid
        API->>R: DEL challenge  &  SADD nullifier (T4)
        API->>PG: INSERT nullifier (unique) + mark challenge CONSUMED
        alt OAuth context present
            API->>PG: create authorization code (60s)
            API-->>U: {code, state, redirect_uri}
        else direct login
            API->>PG: create session (SHA-256 refresh hash)
            API->>R: seed session risk = LOW
            API-->>U: {access_token 15m, refresh_token 7d}
        end
    end
```

---

## 3. Selective Disclosure Flow (sequence diagram)

```mermaid
sequenceDiagram
    autonumber
    participant ISS as Issuer
    participant API as Backend /credential
    participant PG as PostgreSQL
    participant H as Holder (Prover)
    participant VER as Verifier

    Note over ISS,API: Issuance
    ISS->>API: POST issue {attributes}
    API->>API: validate ints [0, 2^32-1]
    API->>API: leaf_i = Poseidon(value_i, salt_i)
    API->>API: build depth-8 Poseidon Merkle tree
    API->>PG: store credential (root) + leaves + salts
    API-->>ISS: credential issued (root)

    Note over H,VER: Presentation of a predicate (e.g. age >= 18)
    H->>H: witness {leaf_value, salt, path[8], indices[8]}
    H->>H: groth16 proof over merkle_disclosure.circom
    H->>API: POST /credential/verify-claim {proof, [root, threshold, leaf_index]}
    API->>PG: fetch credential, check ACTIVE + not expired
    API->>API: assert proof.root == stored root (anti-substitution)
    API->>API: groth16.verify (predicate + Merkle inclusion)
    API->>PG: write audit (hash of signals only)
    API-->>VER: boolean result (value stays hidden)
```

---

## 4. Behavioral Risk + Step-Up Flow (flowchart)

```mermaid
flowchart TD
    A["Client captures behavior events<br/>mouse / key / scroll / touch"] -->|WebSocket| B["Backend relay"]
    B -->|gRPC stream| C["feature_extractor<br/>6-D normalised vector"]
    C --> D["sliding_window<br/>deque maxlen = 50"]
    D --> E{"window full<br/>(50 events)?"}
    E -- no --> D
    E -- yes --> F["LSTM inference<br/>raw score in [0,1]"]
    F --> G["EMA smoothing (T8)<br/>0.3*raw + 0.7*prev"]
    G --> H["classify + jitter (T10)"]
    H --> I{"smoothed score"}
    I -- "< 0.75" --> J["risk_level update only<br/>push RISK_UPDATE to client"]
    I -- ">= 0.75 and < 0.90" --> K["SOFT step-up<br/>PIN / TOTP"]
    I -- ">= 0.90" --> L["HARD step-up<br/>full ZKP re-auth"]
    K --> M["Redis stepup:sessionId (TTL 300s)<br/>emit STEP_UP_REQUIRED (WS)"]
    L --> M
    M --> N["riskGate middleware blocks<br/>authenticated requests"]
    N --> O{"re-auth<br/>successful?"}
    O -- yes --> P["resolveStepUp<br/>clear key, risk -> LOW"]
    O -- no --> N
    J --> Q[("TimescaleDB risk_scores")]
    G -. circuit breaker OPEN .-> R["suppress step-up<br/>update Redis only"]
```

---

## 5. Registration + Recovery Flow (flowchart)

```mermaid
flowchart TD
    subgraph REG["Registration (one-time)"]
        A1["Client: generate 32B secret"] --> A2["commitment = Poseidon(secret)"]
        A2 -->|"send commitment + pubkey only"| A3["POST /auth/register"]
        A3 --> A4{"commitment<br/>already exists?"}
        A4 -- yes --> A5["constant-time 300ms delay<br/>409 generic error"]
        A4 -- no --> A6["create user (tx)"]
        A6 --> A7["BIP-39 mnemonic<br/>Argon2id hash stored"]
        A7 --> A8["return mnemonic ONCE"]
    end

    subgraph REC["Recovery (lost key)"]
        B1["POST /auth/recover<br/>{mnemonic, new commitment}"] --> B2["Argon2id verify mnemonic"]
        B2 --> B3["burn recovery code<br/>revoke all sessions"]
        B3 --> B4["replace commitment<br/>status = PENDING_VERIFY"]
        B4 --> B5["issue 15-min recovery JWT"]
        B5 --> B6["new device: ZKP verify<br/>with X-Recovery-Token"]
        B6 --> B7["status -> ACTIVE"]
    end
```
