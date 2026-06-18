// ZK-Auth Disclosure Circuit Benchmark
// Measures Groth16 fullProve() and a simulated verify round trip for the
// merkle_disclosure circuit -- fills the two [TBD] rows in Table I of the paper.
//
// Prerequisites: ./start.sh must be running (needs the backend for /credential endpoints).
// Usage:
//   cd benchmark
//   node run_disclosure_benchmark.mjs --trials 30
//
// Output: benchmark/results/disclosure-benchmark-<date>.json

import poseidon from 'circomlibjs/src/poseidon.js';
import * as snarkjs from 'snarkjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DISC_WASM = path.join(REPO_ROOT, 'backend/circuits/disclosure/merkle_disclosure_js/merkle_disclosure.wasm');
const DISC_ZKEY = path.join(REPO_ROOT, 'backend/circuits/disclosure/merkle_disclosure.zkey');
const DISC_VKEY = path.join(REPO_ROOT, 'backend/circuits/disclosure/verification_key.json');

const BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function getArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const TRIALS = parseInt(getArg('--trials', '30'), 10);

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }
function round(x) { return Math.round(x * 1000) / 1000; }

function stats(values) {
  if (!values.length) return { n: 0, mean: null, median: null, stddev: null, min: null, max: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const pct = p => sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
  return { n, mean: round(mean), median: round(pct(50)), stddev: round(Math.sqrt(variance)),
           min: round(sorted[0]), max: round(sorted[n - 1]), p95: round(pct(95)), p99: round(pct(99)) };
}

// poseidon(inputs) takes an array of BigInts and returns a BigInt result.
// We use it directly -- no .F wrapper needed, no async build step.
function poseidonHash(...args) {
  // circomlibjs poseidon accepts Number/BigInt, returns a BigInt-compatible value
  return BigInt(poseidon(args));
}

// Build a realistic-looking but fully synthetic Merkle disclosure input.
// The circuit expects:
//   private: leaf_value, salt, path_elements[8], path_indices[8]
//   public:  root, threshold, leaf_index
// We construct a depth-8 Poseidon Merkle tree with random leaf values,
// then generate a real membership proof for leaf 0 with a GTE predicate.
function buildDisclosureInput() {
  const DEPTH = 8;
  const N_LEAVES = 1 << DEPTH;  // 256

  // Generate random leaf values and salts
  const values = [];
  const salts = [];
  const leaves = [];
  for (let i = 0; i < N_LEAVES; i++) {
    const v = (BigInt(Math.floor(Math.random() * 100) + 1)) % BN254_P;  // 1..100
    const s = (BigInt('0x' + crypto.randomBytes(31).toString('hex'))) % BN254_P;
    values.push(v);
    salts.push(s);
    leaves.push(poseidonHash(v, s));
  }

  // Build full Merkle tree bottom-up
  let level = [...leaves];
  const tree = [level];
  for (let d = 0; d < DEPTH; d++) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(poseidonHash(level[i], level[i + 1]));
    }
    level = next;
    tree.push(level);
  }
  const root = level[0];

  // Prove membership of leaf 0, predicate: value >= threshold (GTE)
  const leafIndex = 0;
  const leafValue = values[leafIndex];
  const leafSalt = salts[leafIndex];
  const threshold = leafValue - 1n;  // always true: value >= threshold

  // Build Merkle path for leaf 0
  const pathElements = [];
  const pathIndices = [];
  let idx = leafIndex;
  let currentLevel = [...leaves];
  for (let d = 0; d < DEPTH; d++) {
    const sibling = idx % 2 === 0 ? currentLevel[idx + 1] : currentLevel[idx - 1];
    pathElements.push(sibling.toString());
    pathIndices.push(idx % 2);
    idx = Math.floor(idx / 2);
    currentLevel = tree[d + 1];
  }

  return {
    // Private
    leaf_value: leafValue.toString(),
    salt: leafSalt.toString(),
    path_elements: pathElements,
    path_indices: pathIndices,
    // Public
    root: root.toString(),
    threshold: threshold.toString(),
    leaf_index: leafIndex.toString(),
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ZK-Auth Disclosure Circuit Benchmark');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Trials: ${TRIALS}`);
  console.log(`  Machine: ${os.cpus()[0]?.model ?? 'unknown'} / ${os.platform()} ${os.arch()}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const f of [DISC_WASM, DISC_ZKEY, DISC_VKEY]) {
    if (!fs.existsSync(f)) {
      console.error(`ERROR: Missing circuit artifact: ${f}`);
      console.error('These should be committed to the repo. Run snarkjs circuit compile if missing.');
      process.exit(1);
    }
  }

  const vKey = JSON.parse(fs.readFileSync(DISC_VKEY, 'utf8'));

  console.log('Building Merkle tree for disclosure inputs...');
  const discInput = buildDisclosureInput();
  console.log('Done. Running prove + verify trials...\n');

  const proveTimes = [];
  const verifyTimes = [];

  for (let i = 0; i < TRIALS; i++) {
    process.stdout.write(`  [${i + 1}/${TRIALS}]\r`);

    // Prove
    const t0 = nowMs();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(discInput, DISC_WASM, DISC_ZKEY);
    const proveMs = nowMs() - t0;
    proveTimes.push(round(proveMs));

    // Verify (local, not HTTP round trip -- disclosure verification is client-server)
    const t1 = nowMs();
    const ok = await snarkjs.groth16.verify(vKey, publicSignals, proof);
    const verifyMs = nowMs() - t1;
    verifyTimes.push(round(verifyMs));

    if (!ok) {
      console.error(`\nERROR: Proof verification failed at trial ${i + 1}`);
      process.exit(1);
    }
  }

  const proveStats = stats(proveTimes);
  const verifyStats = stats(verifyTimes);

  console.log(`\n  Prove (${TRIALS} trials):`);
  console.log(`    Median: ${proveStats.median} ms  |  p95: ${proveStats.p95} ms  |  std: ${proveStats.stddev} ms`);
  console.log(`    Min: ${proveStats.min} ms  |  Max: ${proveStats.max} ms`);
  console.log(`\n  Verify (local snarkjs, no HTTP padding):`);
  console.log(`    Median: ${verifyStats.median} ms  |  p95: ${verifyStats.p95} ms  |  std: ${verifyStats.stddev} ms`);
  console.log(`    Min: ${verifyStats.min} ms  |  Max: ${verifyStats.max} ms`);

  const result = {
    circuit: 'merkle_disclosure',
    circuitFile: DISC_WASM,
    zkeyFile: DISC_ZKEY,
    generatedAt: new Date().toISOString(),
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      memGB: round(os.totalmem() / 1024 ** 3),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
    },
    trials: TRIALS,
    note: 'Verify timings here are RAW snarkjs local verification (no HTTP, no T14 timing pad). ' +
          'In the real backend, /credential/verify-claim adds its own constant-time floor. ' +
          'Auth circuit used T14-padded verify; disclosure raw verify is reported separately ' +
          'to isolate pure cryptographic verification cost.',
    disclosureProveLocal_ms: proveStats,
    disclosureVerifyLocal_ms: verifyStats,
    rawTrials: proveTimes.map((p, i) => ({ trial: i + 1, proveMs: p, verifyMs: verifyTimes[i] })),
  };

  const dateStr = new Date().toISOString().slice(0, 10);
  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `disclosure-benchmark-${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(`\n  Output: ${outPath}`);
  console.log('\n  ┌─ PASTE INTO PAPER (Table I, disclosure rows) ──────────┐');
  console.log(`  │  Disclosure Proof Gen.  median: ${proveStats.median} ms  p95: ${proveStats.p95} ms  std: ${proveStats.stddev} ms │`);
  console.log(`  │  Disclosure Verify      median: ${verifyStats.median} ms  p95: ${verifyStats.p95} ms  std: ${verifyStats.stddev} ms │`);
  console.log('  └────────────────────────────────────────────────────────┘\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
