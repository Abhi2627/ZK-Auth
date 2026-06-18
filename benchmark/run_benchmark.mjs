// ZK-Auth Research Benchmark — collects real, measured data for the
// thesis and both papers. Every number here comes from actually exercising
// the real backend (real Poseidon, real Groth16 proving via snarkjs, real
// HTTP round trips to the real Express/Postgres/Redis stack) — nothing is
// simulated or hand-waved.
//
// ─── FOR CONTRIBUTORS RUNNING THIS ON YOUR OWN LAPTOP ────────────────────────
// See SETUP_FOR_BENCHMARKING.md in the repo root for full setup instructions.
// Short version:
//   1. npm install   (ONCE, from the REPO ROOT, not this folder — this script
//      relies on circomlibjs/snarkjs/argon2 already being installed as part
//      of the backend workspace; no separate package.json in benchmark/)
//   2. ./start.sh   (starts Docker infra + backend + web)
//   3. cd benchmark && node run_benchmark.mjs --name "yourname"
//   4. Send the ONE file it produces (zkauth-benchmark-<yourname>-<date>.json)
//      back via WhatsApp/email — that's the only file needed.
//
// What this measures, per trial:
//   1. ZKP login cycle: challenge fetch -> Poseidon hash -> Groth16
//      fullProve() -> /auth/verify round trip. Each phase timed separately.
//   2. Network payload sizes: challenge response, proof+publicSignals
//      request body, verify response.
//   3. Proof size (serialized JSON bytes) -- a standalone ZKP-specific cost
//      metric papers in this space report.
//   4. Argon2id baseline cost (this project's own recovery-flow hashing
//      parameters), as a reference cost for the "traditional password" auth
//      comparison, since Argon2id is the de facto modern password-hashing
//      standard.
//   5. Hardware/OS fingerprint of the machine this ran on (CPU model, core
//      count, total RAM, OS, Node version) -- embedded directly in the
//      output file so results from different contributors are
//      self-describing and don't depend on anyone remembering to report
//      their specs separately.
//
// IMPORTANT METHODOLOGICAL NOTE -- read before citing /auth/verify numbers:
//   backend/src/services/zkp/zkp.service.ts pads EVERY verify() call to a
//   minimum of ~50ms (+/-10ms jitter) as a deliberate timing-attack
//   mitigation (T14: prevents an attacker inferring user existence from
//   response-time differences). This means raw /auth/verify wall-clock
//   time measured here reflects (real verification cost) + (artificial
//   padding floor), NOT pure cryptographic verification cost. The output
//   reports both the total measured latency (what a real client
//   experiences) AND flags the padding constant explicitly, so you can
//   correctly describe which number is "real-world latency including
//   security hardening" vs. "raw verification cost" in the paper.
//
// Usage:
//   node run_benchmark.mjs --name "yourname" [--trials 60] [--api http://localhost:3001/api/v1]
//
//   --name     REQUIRED. Used in the output filename so multiple
//              contributors' files don't collide or get mixed up.
//   --trials   Optional, default 60. 100+ recommended if your machine and
//              patience allow; 60 is enough for a meaningful comparison.
//   --api      Optional, default http://localhost:3001/api/v1. Only change
//              this if you're benchmarking a non-default backend address.
//
// Output: ONE file, zkauth-benchmark-<name>-<YYYY-MM-DD>.json
//   Contains: every trial's raw timings, aggregated stats, hardware
//   fingerprint, and the methodology notes above -- everything needed to
//   use this data, nothing else to attach.

import poseidon from 'circomlibjs/src/poseidon.js';
import * as snarkjs from 'snarkjs';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Config / CLI args ────────────────────────────────────────────────────────

function getArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const CONTRIBUTOR_NAME = getArg('--name', null);
const TRIALS = parseInt(getArg('--trials', '60'), 10);
const API_BASE = getArg('--api', 'http://localhost:3001/api/v1');

if (!CONTRIBUTOR_NAME) {
  console.error('ERROR: --name is required, e.g.:');
  console.error('  node run_benchmark.mjs --name "rohan"');
  console.error('This is used in the output filename so multiple people\'s results don\'t collide.');
  process.exit(1);
}

// Sanitize for safe use in a filename (letters, numbers, dash, underscore only)
const SAFE_NAME = CONTRIBUTOR_NAME.replace(/[^a-zA-Z0-9_-]/g, '_');

const WASM_PATH = path.join(REPO_ROOT, 'backend/circuits/auth/auth_js/auth.wasm');
const ZKEY_PATH = path.join(REPO_ROOT, 'backend/circuits/auth/auth.zkey');

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
  if (values.length === 0) {
    return { n: 0, mean: null, median: null, stddev: null, min: null, max: null, p95: null, p99: null };
  }
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

/**
 * Hardware/OS fingerprint, gathered entirely from Node's built-in `os`
 * module -- no external dependencies, works identically on macOS, Windows,
 * and Linux. Embedded directly in the output so every result file is
 * self-describing.
 */
function getMachineFingerprint() {
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
  return {
    contributorName: CONTRIBUTOR_NAME,
    os: {
      platform: os.platform(),       // 'darwin' | 'win32' | 'linux'
      release: os.release(),
      arch: os.arch(),                // 'x64' | 'arm64' etc.
    },
    cpu: {
      model: cpuModel,
      logicalCores: cpus.length,
    },
    memoryTotalGB: round(os.totalmem() / (1024 ** 3)),
    nodeVersion: process.version,
    hostnameHash: crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12),
    // hostname itself is hashed, not stored raw -- avoids leaking a
    // contributor's actual device/computer name while still letting you
    // tell two distinct machines apart if the same person runs this twice.
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const fingerprint = getMachineFingerprint();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ZK-Auth Research Benchmark');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Contributor:  ${CONTRIBUTOR_NAME}`);
  console.log(`  Machine:      ${fingerprint.cpu.model} (${fingerprint.cpu.logicalCores} cores), ${fingerprint.memoryTotalGB} GB RAM`);
  console.log(`  OS:           ${fingerprint.os.platform} ${fingerprint.os.release} (${fingerprint.os.arch})`);
  console.log(`  Node:         ${fingerprint.nodeVersion}`);
  console.log(`  Trials:       ${TRIALS}`);
  console.log(`  API:          ${API_BASE}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!fs.existsSync(WASM_PATH)) {
    console.error(`ERROR: auth.wasm not found at ${WASM_PATH}`);
    console.error('Did you clone the full repo? This file should already be committed --');
    console.error('see SETUP_FOR_BENCHMARKING.md if it\'s missing.');
    process.exit(1);
  }
  if (!fs.existsSync(ZKEY_PATH)) {
    console.error(`ERROR: auth.zkey not found at ${ZKEY_PATH}`);
    console.error('Did you clone the full repo? This file should already be committed --');
    console.error('see SETUP_FOR_BENCHMARKING.md if it\'s missing.');
    process.exit(1);
  }

  // ── One-time registration ─────────────────────────────────────────────────
  // Real users register once, then log in repeatedly -- this mirrors that,
  // and avoids the (intentionally tight, even after raising) /register limit.
  console.log('Registering one benchmark account...');
  const secretBytes = crypto.randomBytes(32);
  const secretHex = secretBytes.toString('hex');
  const secretField = hexToField(secretHex);
  const commitmentField = poseidon([secretField]);
  const commitmentHash = commitmentField.toString();
  const publicKeyHex = secretHex;

  const registerRes = await httpJson(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commitment_hash: commitmentHash,
      public_key_hex: publicKeyHex,
      device_label: `benchmark-${SAFE_NAME}`,
    }),
  });

  if (registerRes.status !== 201) {
    console.error('Registration failed:', registerRes.status, registerRes.raw);
    console.error('\nIs the backend running? Try: ./start.sh from the repo root.');
    console.error('Did it start cleanly? Check .logs/backend.log for errors.');
    process.exit(1);
  }
  console.log(`Registered. user_id=${registerRes.json.user_id}\n`);

  // ── Argon2id baseline ──────────────────────────────────────────────────────
  console.log('Benchmarking Argon2id baseline (password-hashing reference cost)...');
  const argon2Times = [];
  const ARGON2_TRIALS = Math.min(30, TRIALS);
  const dummyPassword = 'BenchmarkPassword123!';
  for (let i = 0; i < ARGON2_TRIALS; i++) {
    const t0 = nowMs();
    const hash = await argon2.hash(dummyPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
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

      const tPoseidon0 = nowMs();
      poseidon([secretField, nonceField]); // timed standalone; see header note
      const tPoseidon1 = nowMs();
      trial.poseidonMs = round(tPoseidon1 - tPoseidon0);

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

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const successRows = rows.filter((r) => r.success);
  const failRows = rows.filter((r) => !r.success);

  const result = {
    fileFormatVersion: 1,
    contributor: fingerprint,
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
            'KiB, timeCost=3, parallelism=1). Isolates the cryptographic ' +
            'hashing cost specifically, which is the dominant cost in ' +
            'password auth -- not a full OAuth/password round trip.',
      trials: ARGON2_TRIALS,
      hash: stats(argon2Times.map((t) => t.hashMs)),
      verify: stats(argon2Times.map((t) => t.verifyMs)),
      total: stats(argon2Times.map((t) => t.totalMs)),
    },

    rawTrials: rows,

    methodologyNotes: [
      'All ZKP timings are from a REAL end-to-end pipeline: real Poseidon ' +
        '(circomlibjs), real Groth16 proof generation (snarkjs.groth16.fullProve ' +
        'against the actual compiled auth.wasm/auth.zkey committed in this repo), ' +
        'and real HTTP round trips to a real running Express backend with real ' +
        'Postgres+Redis -- all running locally on the contributor\'s own machine.',
      'verifyServerRoundTrip (/auth/verify) INCLUDES an intentional ~50ms ' +
        '(+/-10ms jitter) artificial delay in backend/src/services/zkp/zkp.service.ts ' +
        '(constant TARGET_VERIFY_MS), added as a timing-attack mitigation (T14: ' +
        'prevents inferring user existence from response-time differences). ' +
        'This means verifyServerRoundTrip reflects (real verification cost + ' +
        'security padding), not raw cryptographic verification cost alone.',
      'groth16ProveLocal is measured on the CONTRIBUTOR\'S machine (see the ' +
        '"contributor" field above for hardware/OS) -- this is the whole point ' +
        'of collecting from multiple devices. It is NOT measured on a mobile ' +
        'device; mobile proof generation uses a separate WebView/JS bridge with ' +
        'different overhead characteristics.',
      'Rate limits were pre-raised in backend/.env.local (committed as ' +
        '.env.local.example) specifically to permit rapid sequential ' +
        'benchmark trials without 429 throttling; this does not affect ' +
        'per-request latency or correctness.',
    ],
  };

  const dateStr = new Date().toISOString().slice(0, 10);
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const outPath = path.join(resultsDir, `zkauth-benchmark-${SAFE_NAME}-${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  DONE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n  Output file: ${outPath}`);
  console.log('\n  >>> Send this ONE file back via WhatsApp/email. <<<\n');
  console.log(`  Success rate: ${result.successRatePct}% (${successRows.length}/${TRIALS})`);
  if (failRows.length > 0) {
    console.log('  Failure breakdown:', result.failureBreakdown);
  }
  console.log('\n  Key numbers:');
  console.log('    Total E2E login latency (median):', result.zkpLoginLatency_ms.totalEndToEnd.median, 'ms');
  console.log('    Groth16 prove time (median):     ', result.zkpLoginLatency_ms.groth16ProveLocal.median, 'ms');
  console.log('    /auth/verify round trip (median):', result.zkpLoginLatency_ms.verifyServerRoundTrip.median, 'ms');
  console.log('    Proof object size (median):      ', result.payloadSizes_bytes.groth16ProofObject.median, 'bytes');
  console.log('    Argon2id baseline (median):      ', result.argon2idBaseline_ms.total.median, 'ms');
  console.log('');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
