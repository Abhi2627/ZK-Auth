// ZK-Auth Research Benchmark — collects real, measured data for the
// thesis and both papers. Every number here comes from actually exercising
// the real backend (real Poseidon, real Groth16 proving via snarkjs, real
// HTTP round trips to the real Express/Postgres/Redis stack) — nothing is
// simulated or hand-waved.
//
// What this measures, per trial:
//   1. ZKP login cycle: challenge fetch -> Poseidon hash -> Groth16
//      fullProve() -> /auth/verify round trip. Each phase timed separately.
//   2. Network payload sizes: challenge response, proof+publicSignals
//      request body, verify response.
//   3. Proof size (serialized JSON bytes) -- a standalone ZKP-specific cost
//      metric papers in this space report.
//   4. Argon2id baseline cost (your own recovery-flow hashing parameters --
//      ARGON2_MEMORY_KIB=65536, ARGON2_ITERATIONS=3, ARGON2_PARALLELISM=1 --
//      already running in graph: same library used for production
//      password-style baseline comparisons). This is reported as a
//      reference cost for the "traditional password" comparison, since
//      Argon2id is the de facto modern standard for password hashing.
//
// IMPORTANT METHODOLOGICAL NOTE -- read before citing /auth/verify numbers:
//   backend/src/services/zkp/zkp.service.ts pads EVERY verify() call to a
//   minimum of ~50ms (+/-10ms jitter) as a deliberate timing-attack
//   mitigation (T14: prevents an attacker inferring user existence from
//   response-time differences). This means raw /auth/verify wall-clock
//   time measured here reflects (real verification cost) + (artificial
//   padding floor), NOT pure cryptographic verification cost. This script
//   reports both the total measured latency (what a real client
//   experiences) AND flags the padding constant explicitly in the summary,
//   so you can correctly describe which number is "real-world latency
//   including security hardening" vs. "raw verification cost" in the paper.
//
// Usage:
//   cd /Users/abhaydandge/Projects/ZK-Auth/benchmark
//   node run_benchmark.mjs --trials 120
//
// Output:
//   results_<timestamp>.csv   -- one row per trial, every phase timed
//   summary_<timestamp>.json  -- aggregated stats (mean/median/p95/stddev)
//
// Prerequisites:
//   - Backend running (./start.sh from repo root) and reachable at
//     API_BASE below.
//   - Rate limits temporarily raised in backend/.env.local (the file actually
//     loaded by `npm run dev --env-file=.env.local` / start.sh -- NOT
//     backend/.env, which is only used for Docker Compose). Already done --
//     RATE_LIMIT_CHALLENGE_PER_MIN / RATE_LIMIT_AUTH_PER_MIN set to 600.
//     Restore to 10/20 in backend/.env.local after data collection is done.

import poseidon from 'circomlibjs/src/poseidon.js';
import * as snarkjs from 'snarkjs';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Config ─────────────────────────────────────────────────────────────────

const API_BASE = process.env.API_BASE || 'http://localhost:3001/api/v1';
const WASM_PATH = path.join(REPO_ROOT, 'backend/circuits/auth/auth_js/auth.wasm');
const ZKEY_PATH = path.join(REPO_ROOT, 'backend/circuits/auth/auth.zkey');

const args = process.argv.slice(2);
const trialsArgIdx = args.indexOf('--trials');
const TRIALS = trialsArgIdx !== -1 ? parseInt(args[trialsArgIdx + 1], 10) : 120;

const BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ─── Helpers ────────────────────────────────────────────────────────────────

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function hexToField(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const v = BigInt('0x' + clean);
  return ((v % BN254_P) + BN254_P) % BN254_P;
}

function byteLength(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

async function httpJson(url, options, timeoutMs = 15000) {
  const start = nowMs();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    const elapsed = nowMs() - start;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, raw: text, elapsedMs: elapsed, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (err) {
    const elapsed = nowMs() - start;
    if (err.name === 'AbortError') {
      return { status: 0, json: null, raw: `TIMEOUT after ${timeoutMs}ms`, elapsedMs: elapsed, bytes: 0, timedOut: true };
    }
    return { status: 0, json: null, raw: `FETCH_ERROR: ${err.message}`, elapsedMs: elapsed, bytes: 0 };
  } finally {
    clearTimeout(timeoutId);
  }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const pct = (p) => sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
  return {
    n,
    mean: round(mean),
    median: round(pct(50)),
    stddev: round(Math.sqrt(variance)),
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
    p95: round(pct(95)),
    p99: round(pct(99)),
  };
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`ZK-Auth Benchmark — ${TRIALS} trials against ${API_BASE}`);
  console.log(`WASM: ${WASM_PATH}`);
  console.log(`ZKEY: ${ZKEY_PATH}\n`);

  if (!fs.existsSync(WASM_PATH)) {
    console.error(`ERROR: auth.wasm not found at ${WASM_PATH}`);
    console.error('Check backend/circuits/auth/auth_js/ contains the compiled witness calculator.');
    process.exit(1);
  }
  if (!fs.existsSync(ZKEY_PATH)) {
    console.error(`ERROR: auth.zkey not found at ${ZKEY_PATH}`);
    process.exit(1);
  }

  console.log('Loading Poseidon (circomlibjs)...');
  // poseidon([...]) returns the hash directly as a BigInt -- no async
  // build step or field-element unwrapping needed (this matches exactly
  // how extract_poseidon.js used this same module earlier in the
  // project, already verified correct against real test vectors).

  // ── One-time registration ─────────────────────────────────────────────────
  // Real users register once, then log in repeatedly -- this mirrors that,
  // and avoids the (intentionally tight, even after raising) /register limit.
  console.log('Registering one benchmark account...');
  const secretBytes = crypto.randomBytes(32);
  const secretHex = secretBytes.toString('hex');
  const secretField = hexToField(secretHex);
  const commitmentField = poseidon([secretField]);
  const commitmentHash = commitmentField.toString();
  const publicKeyHex = secretHex; // 32 bytes hex, reused as a stand-in public key for the benchmark account

  const registerRes = await httpJson(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commitment_hash: commitmentHash,
      public_key_hex: publicKeyHex,
      device_label: 'benchmark-script',
    }),
  });

  if (registerRes.status !== 201) {
    console.error('Registration failed:', registerRes.status, registerRes.raw);
    process.exit(1);
  }
  console.log(`Registered. user_id=${registerRes.json.user_id}\n`);

  // ── Argon2id baseline (your own recovery-flow parameters) ─────────────────
  console.log('Benchmarking Argon2id baseline (password-hashing reference cost)...');
  const argon2Times = [];
  const ARGON2_TRIALS = Math.min(30, TRIALS); // expensive by design; fewer trials is fine, it's a stable reference cost
  const dummyPassword = 'BenchmarkPassword123!';
  for (let i = 0; i < ARGON2_TRIALS; i++) {
    const t0 = nowMs();
    const hash = await argon2.hash(dummyPassword, {
      type: argon2.argon2id,
      memoryCost: 65536, // matches backend/.env ARGON2_MEMORY_KIB
      timeCost: 3,       // matches ARGON2_ITERATIONS
      parallelism: 1,    // matches ARGON2_PARALLELISM
    });
    const hashMs = nowMs() - t0;

    const t1 = nowMs();
    await argon2.verify(hash, dummyPassword);
    const verifyMs = nowMs() - t1;

    argon2Times.push({ hashMs: round(hashMs), verifyMs: round(verifyMs), totalMs: round(hashMs + verifyMs) });
  }
  console.log(`Argon2id: ${ARGON2_TRIALS} trials done.\n`);

  // ── Main ZKP login benchmark loop ──────────────────────────────────────────
  console.log(`Running ${TRIALS} full ZKP login cycles (challenge -> prove -> verify)...`);
  const rows = [];

  for (let i = 0; i < TRIALS; i++) {
    const trial = { trial: i + 1 };
    process.stdout.write(`  [${i + 1}/${TRIALS}] starting...\r`);

    try {
      // ── Phase 1: fetch challenge ──────────────────────────────────────────
      const challengeRes = await httpJson(`${API_BASE}/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitment_hash: commitmentHash }),
      });
      if (challengeRes.status !== 200) {
        trial.error = `challenge_failed_${challengeRes.status}`;
        rows.push(trial);
        continue;
      }
      trial.challengeMs = round(challengeRes.elapsedMs);
      trial.challengeResponseBytes = challengeRes.bytes;

      const { challenge_id, nonce } = challengeRes.json;
      const nonceField = hexToField(nonce);

      // ── Phase 2: real Poseidon hash (nullifier + commitment) ──────────────
      // Timed standalone to isolate pure-hashing cost from the witness/proof
      // generation pipeline below (which also computes Poseidon internally
      // as part of executing the circuit, but bundled with everything else).
      // nullifierField here is NOT reused downstream -- the authoritative
      // nullifier_hash is whatever fullProve()'s publicSignals[0] returns
      // (computed inside the circuit), kept separate so this measurement
      // isn't contaminated by witness-calculation overhead.
      const tPoseidon0 = nowMs();
      const nullifierField = poseidon([secretField, nonceField]);
      const tPoseidon1 = nowMs();
      trial.poseidonMs = round(tPoseidon1 - tPoseidon0);

      // ── Phase 3: real Groth16 fullProve() via snarkjs ──────────────────────
      const tProve0 = nowMs();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        { secret: secretField.toString(), nonce: nonceField.toString() },
        WASM_PATH,
        ZKEY_PATH,
      );
      const tProve1 = nowMs();
      trial.proveMs = round(tProve1 - tProve0);

      const proofPayload = {
        challenge_id,
        proof: { ...proof, curve: 'bn128' },
        public_signals: publicSignals,
      };
      trial.proofSizeBytes = byteLength(proofPayload.proof);
      trial.requestPayloadBytes = byteLength(proofPayload);

      // ── Phase 4: submit proof, real server-side groth16.verify() ──────────
      const verifyRes = await httpJson(`${API_BASE}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proofPayload),
      });
      trial.verifyMs = round(verifyRes.elapsedMs);
      trial.verifyResponseBytes = verifyRes.bytes;
      trial.verifyStatus = verifyRes.status;

      if (verifyRes.status !== 200) {
        trial.error = `verify_failed_${verifyRes.status}`;
        trial.errorDetail = verifyRes.raw?.slice(0, 200);
      } else {
        trial.success = true;
        trial.totalE2eMs = round(
          trial.challengeMs + trial.poseidonMs + trial.proveMs + trial.verifyMs,
        );
      }
    } catch (err) {
      trial.error = `exception: ${err.message}`;
    }

    rows.push(trial);

    if ((i + 1) % 10 === 0 || i === TRIALS - 1) {
      console.log(`  [${i + 1}/${TRIALS}] last trial: ${JSON.stringify({
        challengeMs: trial.challengeMs,
        proveMs: trial.proveMs,
        verifyMs: trial.verifyMs,
        totalE2eMs: trial.totalE2eMs,
        success: trial.success ?? false,
      })}`);
    }
  }

  // ── Write CSV ────────────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = path.join(__dirname, `results_${timestamp}.csv`);
  const csvHeaders = [
    'trial', 'success', 'challengeMs', 'poseidonMs', 'proveMs', 'verifyMs', 'totalE2eMs',
    'challengeResponseBytes', 'proofSizeBytes', 'requestPayloadBytes', 'verifyResponseBytes',
    'verifyStatus', 'error', 'errorDetail',
  ];
  const csvLines = [csvHeaders.join(',')];
  for (const r of rows) {
    csvLines.push(csvHeaders.map((h) => {
      const v = r[h];
      if (v === undefined || v === null) return '';
      if (typeof v === 'string' && v.includes(',')) return `"${v.replace(/"/g, '""')}"`;
      return v;
    }).join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  // ── Aggregate + write summary JSON ──────────────────────────────────────
  const successRows = rows.filter((r) => r.success);
  const failRows = rows.filter((r) => !r.success);

  const summary = {
    generatedAt: new Date().toISOString(),
    apiBase: API_BASE,
    trialsRequested: TRIALS,
    trialsSucceeded: successRows.length,
    trialsFailed: failRows.length,
    successRatePct: round((successRows.length / TRIALS) * 100),
    failureBreakdown: failRows.reduce((acc, r) => {
      acc[r.error] = (acc[r.error] || 0) + 1;
      return acc;
    }, {}),

    zkpLoginLatency_ms: {
      challenge: stats(successRows.map((r) => r.challengeMs)),
      poseidonHash: stats(successRows.map((r) => r.poseidonMs)),
      groth16ProveLocal: stats(successRows.map((r) => r.proveMs)),
      verifyServerRoundTrip: stats(successRows.map((r) => r.verifyMs)),
      totalEndToEnd: stats(successRows.map((r) => r.totalE2eMs)),
    },

    payloadSizes_bytes: {
      challengeResponse: stats(successRows.map((r) => r.challengeResponseBytes)),
      groth16ProofObject: stats(successRows.map((r) => r.proofSizeBytes)),
      fullVerifyRequest: stats(successRows.map((r) => r.requestPayloadBytes)),
      verifyResponse: stats(successRows.map((r) => r.verifyResponseBytes)),
    },

    argon2idBaseline_ms: {
      note: 'Reference cost for traditional password-style auth, using this ' +
            'project\'s own production Argon2id parameters (memoryCost=65536 ' +
            'KiB, timeCost=3, parallelism=1) from backend/.env. Not a full ' +
            'OAuth/password round trip -- isolates the cryptographic hashing ' +
            'cost specifically, which is the dominant cost in password auth.',
      trials: ARGON2_TRIALS,
      hash: stats(argon2Times.map((t) => t.hashMs)),
      verify: stats(argon2Times.map((t) => t.verifyMs)),
      total: stats(argon2Times.map((t) => t.totalMs)),
    },

    methodologyNotes: [
      'All ZKP timings are from a REAL end-to-end pipeline: real Poseidon ' +
        '(circomlibjs), real Groth16 proof generation (snarkjs.groth16.fullProve ' +
        'against the actual compiled auth.wasm/auth.zkey), and real HTTP round ' +
        'trips to the actual running Express backend with real Postgres+Redis.',
      'verifyServerRoundTrip (/auth/verify) INCLUDES an intentional ~50ms ' +
        '(+/-10ms jitter) artificial delay in backend/src/services/zkp/zkp.service.ts ' +
        '(constant TARGET_VERIFY_MS), added as a timing-attack mitigation (T14: ' +
        'prevents inferring user existence from response-time differences). ' +
        'This means verifyServerRoundTrip reflects (real verification cost + ' +
        'security padding), not raw cryptographic verification cost alone. ' +
        'Report this explicitly if comparing against systems without equivalent ' +
        'timing-attack hardening.',
      'groth16ProveLocal is measured on this benchmark machine (the developer ' +
        'machine running this script), using Node.js snarkjs -- NOT measured on ' +
        'the actual mobile device. Mobile proof generation (via the WebView/JS ' +
        'bridge) has a separate, higher cost due to WebView startup and JS ' +
        'engine overhead; benchmark that path separately on-device if the paper ' +
        'needs mobile-specific numbers.',
      'Rate limits (RATE_LIMIT_CHALLENGE_PER_MIN, RATE_LIMIT_AUTH_PER_MIN) were ' +
        'temporarily raised in backend/.env.local (the file actually loaded by ' +
        'npm run dev / start.sh) to permit rapid sequential trials; this does ' +
        'not affect per-request latency or correctness, only the rate at ' +
        'which trials could be run.',
    ],
  };

  const summaryPath = path.join(__dirname, `summary_${timestamp}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log('\n─── Done ───────────────────────────────────────────────');
  console.log(`Raw per-trial data: ${csvPath}`);
  console.log(`Aggregated summary: ${summaryPath}`);
  console.log(`\nSuccess rate: ${summary.successRatePct}% (${successRows.length}/${TRIALS})`);
  if (failRows.length > 0) {
    console.log('Failure breakdown:', summary.failureBreakdown);
  }
  console.log('\nKey numbers:');
  console.log('  Total E2E login latency (median):', summary.zkpLoginLatency_ms.totalEndToEnd.median, 'ms');
  console.log('  Groth16 prove time (median):', summary.zkpLoginLatency_ms.groth16ProveLocal.median, 'ms');
  console.log('  /auth/verify round trip (median):', summary.zkpLoginLatency_ms.verifyServerRoundTrip.median, 'ms');
  console.log('  Proof object size (median):', summary.payloadSizes_bytes.groth16ProofObject.median, 'bytes');
  console.log('  Argon2id baseline (median):', summary.argon2idBaseline_ms.total.median, 'ms');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
