// ZK-Auth Throughput Benchmark
// Measures server-side /auth/verify throughput under concurrent load.
// Fills the scalability discussion section with real numbers.
//
// This script pre-generates N valid proofs offline (snarkjs is slow per proof),
// then replays them concurrently against the backend verify endpoint to measure
// pure server throughput (not client-side proving speed, which is already
// measured in run_benchmark.mjs).
//
// Usage:
//   ./start.sh  (must be running)
//   cd benchmark
//   node run_throughput_benchmark.mjs
//
// Output: benchmark/results/throughput-benchmark-<date>.json

import * as snarkjs from 'snarkjs';
import poseidon from 'circomlibjs/src/poseidon.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const WASM_PATH = path.join(REPO_ROOT, 'backend/circuits/auth/auth_js/auth.wasm');
const ZKEY_PATH = path.join(REPO_ROOT, 'backend/circuits/auth/auth.zkey');
const API_BASE  = 'http://localhost:3001/api/v1';
const BN254_P   = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const CONCURRENCY_LEVELS = [1, 5, 10, 25, 50];  // concurrent requests per burst
const BURSTS_PER_LEVEL = 10;                      // measure N bursts per concurrency level
const PRE_GENERATE_COUNT = 600;                   // proofs to pre-generate offline

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }
function round(x) { return Math.round(x * 1000) / 1000; }

function hexToField(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const v = BigInt('0x' + clean);
  return ((v % BN254_P) + BN254_P) % BN254_P;
}

function stats(values) {
  if (!values.length) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const pct = p => sorted[Math.min(n - 1, Math.floor(p / 100 * n))];
  return { n, mean: round(mean), median: round(pct(50)), stddev: round(Math.sqrt(variance)),
           min: round(sorted[0]), max: round(sorted[n - 1]), p95: round(pct(95)), p99: round(pct(99)) };
}

async function registerUser(secretField, commitmentHash) {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commitment_hash: commitmentHash,
      public_key_hex: secretField.toString(16),
      device_label: 'throughput-benchmark',
    }),
  });
  if (res.status !== 201) throw new Error(`Register failed: ${res.status} ${await res.text()}`);
  return (await res.json()).user_id;
}

async function getChallenge(commitmentHash) {
  const res = await fetch(`${API_BASE}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commitment_hash: commitmentHash }),
  });
  if (res.status !== 200) throw new Error(`Challenge failed: ${res.status}`);
  return res.json();
}

async function verifyProof(payload) {
  const t0 = nowMs();
  const res = await fetch(`${API_BASE}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const latency = nowMs() - t0;
  return { status: res.status, latencyMs: round(latency) };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ZK-Auth Throughput Benchmark');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Concurrency levels: ${CONCURRENCY_LEVELS.join(', ')}`);
  console.log(`  Bursts per level: ${BURSTS_PER_LEVEL}`);
  console.log(`  Pre-generating ${PRE_GENERATE_COUNT} proofs offline first...`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── Register one benchmark user ───────────────────────────────────────────
  const secretBytes = crypto.randomBytes(32);
  const secretHex = secretBytes.toString('hex');
  const secretField = hexToField(secretHex);
  const commitmentHash = poseidon([secretField]).toString();

  console.log('Registering benchmark user...');
  await registerUser(secretField, commitmentHash);
  console.log('Registered.\n');

  // ── Pre-generate proofs offline (slow part — takes ~60s for 200 proofs) ──
  console.log(`Pre-generating ${PRE_GENERATE_COUNT} valid proofs (takes ~${Math.round(PRE_GENERATE_COUNT * 62 / 1000)}s)...`);
  const pregenProofs = [];
  for (let i = 0; i < PRE_GENERATE_COUNT; i++) {
    process.stdout.write(`  [${i + 1}/${PRE_GENERATE_COUNT}] generating...\r`);
    const challenge = await getChallenge(commitmentHash);
    const nonceField = hexToField(challenge.nonce);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      { secret: secretField.toString(), nonce: nonceField.toString() },
      WASM_PATH, ZKEY_PATH,
    );
    pregenProofs.push({
      challenge_id: challenge.challenge_id,
      proof: { ...proof, curve: 'bn128' },
      public_signals: publicSignals,
    });
  }
  console.log(`\nPre-generation done. ${pregenProofs.length} proofs ready.\n`);

  // ── Throughput measurement ────────────────────────────────────────────────
  const results = {};
  let proofIdx = 0;

  for (const concurrency of CONCURRENCY_LEVELS) {
    const latencies = [];
    const statusCodes = {};
    let errors = 0;

    console.log(`\nConcurrency = ${concurrency} (${BURSTS_PER_LEVEL} bursts of ${concurrency} requests each):`);

    for (let burst = 0; burst < BURSTS_PER_LEVEL; burst++) {
      const batch = [];
      for (let j = 0; j < concurrency; j++) {
        if (proofIdx >= pregenProofs.length) {
          console.error(`\nFatal: Ran out of pre-generated proofs at c=${concurrency} burst ${burst+1}.`);
          console.error(`Increase PRE_GENERATE_COUNT above ${PRE_GENERATE_COUNT} and rerun.`);
          process.exit(1);
        }
        batch.push(pregenProofs[proofIdx++]);
      }
      if (!batch.length) break;

      const t0 = nowMs();
      const outcomes = await Promise.all(batch.map(p => verifyProof(p)));
      const wallMs = nowMs() - t0;

      for (const o of outcomes) {
        latencies.push(o.latencyMs);
        statusCodes[o.status] = (statusCodes[o.status] || 0) + 1;
        if (o.status !== 200) errors++;
      }

      const rps = round((concurrency / wallMs) * 1000);
      process.stdout.write(`  burst ${burst + 1}/${BURSTS_PER_LEVEL}: wall ${round(wallMs)}ms, ${rps} req/s\n`);
    }

    const latStats = stats(latencies);
    const successCount = statusCodes[200] || 0;
    const totalRequests = latencies.length;
    // Throughput: total successful reqs / total wall time (approximate: assumes bursts are back-to-back)
    // More accurately, we report peak concurrency RPS from the median burst wall time
    const approxRPS = round((concurrency / (latStats.median || 1)) * 1000);

    results[`concurrency_${concurrency}`] = {
      concurrency,
      totalRequests,
      successCount,
      errorCount: errors,
      statusBreakdown: statusCodes,
      latency_ms: latStats,
      approxRPS_at_median_latency: approxRPS,
    };

    console.log(`  → Median latency: ${latStats.median}ms  p95: ${latStats.p95}ms  Errors: ${errors}/${totalRequests}`);
    console.log(`  → Approx throughput: ~${approxRPS} req/s`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      memGB: round(os.totalmem() / 1024 ** 3),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
    },
    note: 'Server and benchmark client running on same machine (localhost). ' +
          'Client-side proof generation cost excluded (proofs pre-generated offline). ' +
          'Measures pure server-side verify throughput: JWT decode + snarkjs verify + ' +
          'Redis nullifier check + DB insert + 50ms T14 timing pad. ' +
          'Production deployment (separate server + client machines, backend scaling) ' +
          'would show higher throughput than these single-machine numbers.',
    concurrencyLevels: CONCURRENCY_LEVELS,
    results,
  };

  const dateStr = new Date().toISOString().slice(0, 10);
  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `throughput-benchmark-${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  THROUGHPUT SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  for (const [key, r] of Object.entries(results)) {
    console.log(`  c=${r.concurrency}: median ${r.latency_ms.median}ms  p95 ${r.latency_ms.p95}ms  ~${r.approxRPS_at_median_latency} req/s`);
  }
  console.log(`\n  Full results: ${outPath}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
