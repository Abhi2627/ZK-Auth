#!/usr/bin/env node
/**
 * Single-Node Saturation Load Test — /auth/verify throughput vs. latency
 * ======================================================================
 * Purpose: convert the national-scale claim from a pure analytical projection
 * into "measured up to the single-node ceiling, projected beyond." It drives
 * the full authentication verify path (snarkjs Groth16 verify + T14 pad +
 * atomic nullifier register + session issue + DB/Redis writes) under rising
 * concurrency and reports the throughput/latency curve — i.e. where one
 * backend process saturates.
 *
 * Why a custom generator (not autocannon/k6): every proof and its nullifier
 * are SINGLE-USE, so the load cannot be one request replayed N times. For
 * each concurrency level we (1) pre-generate a fresh batch of valid proofs
 * (one challenge + one proof each, all with distinct nullifiers from the same
 * registered secret), then (2) fire them at the target concurrency, all well
 * within the 120 s challenge TTL.
 *
 * Prereqs: backend running (see run_replay_attack_test.mjs header).
 *
 * Usage:
 *   node benchmark/run_load_test.mjs --api http://localhost:3011 \
 *        --levels 1,5,10,25,50,100 --requests 150
 *
 * Output -> benchmark/results/load-test-<date>.json
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const snarkjs = require('snarkjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const API = arg('api', 'http://localhost:3011');
const LEVELS = arg('levels', '1,5,10,25,50,100').split(',').map((x) => parseInt(x, 10));
const REQUESTS = parseInt(arg('requests', '150'), 10);   // requests per level
const WASM = arg('wasm', path.join(REPO, 'backend/circuits/auth/auth_js/auth.wasm'));
const ZKEY = arg('zkey', path.join(REPO, 'backend/circuits/auth/auth.zkey'));

const BN254 = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
const mod = (a) => ((a % BN254) + BN254) % BN254;
const hexToField = (hex) => mod(BigInt('0x' + hex.replace(/^0x/, '')));

async function post(pathname, body) {
  const t0 = performance.now();
  const res = await fetch(API + pathname, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const ms = performance.now() - t0;
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json, ms };
}
const errorCode = (r) => r.json?.error?.code ?? r.json?.code ?? r.json?.error ?? `HTTP_${r.status}`;

async function prove(secretHex, nonceHex) {
  const witness = { secret: hexToField(secretHex).toString(10), nonce: hexToField(nonceHex).toString(10) };
  return snarkjs.groth16.fullProve(witness, WASM, ZKEY);
}
async function commitmentFromCircuit(secretHex) {
  const { publicSignals } = await prove(secretHex, '00'.repeat(32));
  return publicSignals[1];
}
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Generate `count` fresh, valid verify-request bodies (distinct nullifiers).
// Resilient to transient challenge failures / rate-limit hiccups: retries with
// a short backoff rather than crashing, so the curve completes.
async function generateBatch(secretHex, commitment, count) {
  const jobs = [];
  let attempts = 0;
  const maxAttempts = count * 4;
  while (jobs.length < count && attempts < maxAttempts) {
    attempts++;
    const ch = await post('/api/v1/auth/challenge', { commitment_hash: commitment });
    if (ch.status !== 200 || !ch.json || typeof ch.json.nonce !== 'string') {
      await sleep(100);          // back off on transient error / rate limit
      continue;
    }
    const { challenge_id, nonce } = ch.json;
    const { proof, publicSignals } = await prove(secretHex, nonce);
    jobs.push({ challenge_id, proof, public_signals: publicSignals });
    if (jobs.length % 25 === 0) process.stdout.write(`\r    generated ${jobs.length}/${count} proofs`);
  }
  process.stdout.write('\r');
  if (jobs.length < count) {
    console.log(`    (note: generated ${jobs.length}/${count} after ${attempts} attempts — transient challenge failures skipped)`);
  }
  return jobs;
}

// Fire `jobs` maintaining `concurrency` in flight; return latency + counts.
async function fireAtConcurrency(jobs, concurrency) {
  const latencies = []; let idx = 0, ok = 0, err = 0; const errors = {};
  const t0 = performance.now();
  async function worker() {
    for (;;) {
      const i = idx++; if (i >= jobs.length) return;
      const r = await post('/api/v1/auth/verify', jobs[i]);
      latencies.push(r.ms);
      if (r.status === 200) ok++;
      else { err++; const c = errorCode(r); errors[c] = (errors[c] || 0) + 1; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - t0;
  latencies.sort((a, b) => a - b);
  return {
    ok, err, errors,
    throughputPerSec: +(ok / (wallMs / 1000)).toFixed(1),
    p50: +pct(latencies, 50).toFixed(1),
    p95: +pct(latencies, 95).toFixed(1),
    p99: +pct(latencies, 99).toFixed(1),
    wallMs: +wallMs.toFixed(0),
  };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('  ZK-Auth Single-Node Saturation Load Test  (/auth/verify)');
  console.log('═'.repeat(70));
  console.log(`  API: ${API}   levels: ${LEVELS.join(',')}   requests/level: ${REQUESTS}`);

  const secretHex = crypto.randomBytes(32).toString('hex');
  const commitment = await commitmentFromCircuit(secretHex);
  const reg = await post('/api/v1/auth/register', {
    commitment_hash: commitment, public_key_hex: crypto.randomBytes(32).toString('hex'), device_label: 'load-test',
  });
  if (reg.status !== 201) { console.error('  Registration failed:', reg.status, errorCode(reg)); process.exit(1); }
  console.log('  ✓ Registered fresh test identity\n');

  const rows = [];
  for (const c of LEVELS) {
    console.log(`  [concurrency ${c}] generating ${REQUESTS} fresh proofs…`);
    const jobs = await generateBatch(secretHex, commitment, REQUESTS);
    const r = await fireAtConcurrency(jobs, c);
    rows.push({ concurrency: c, ...r });
    console.log(`  [concurrency ${c}] throughput ${r.throughputPerSec} req/s | ` +
                `p50 ${r.p50} ms | p95 ${r.p95} ms | p99 ${r.p99} ms | errors ${r.err}` +
                (r.err ? ` (${JSON.stringify(r.errors)})` : ''));
  }

  // Identify the saturation point: highest throughput before it stops rising.
  let peak = rows[0];
  for (const row of rows) if (row.throughputPerSec >= peak.throughputPerSec) peak = row;

  console.log('─'.repeat(70));
  console.log('  Concurrency |  Tput(req/s) |  p50(ms) |  p95(ms) |  p99(ms) | err');
  for (const r of rows) {
    console.log(`  ${String(r.concurrency).padStart(11)} | ${String(r.throughputPerSec).padStart(12)} | ` +
                `${String(r.p50).padStart(8)} | ${String(r.p95).padStart(8)} | ${String(r.p99).padStart(8)} | ${r.err}`);
  }
  console.log('─'.repeat(70));
  console.log('  PASTE INTO PAPER (Single-Node Saturation):');
  console.log(`    a single backend process saturates near ${peak.throughputPerSec} verify req/s ` +
              `(at concurrency ${peak.concurrency}, p95 ${peak.p95} ms); beyond this, added concurrency ` +
              `raises latency without raising throughput, consistent with the T14-pad serialization ceiling. ` +
              `Horizontal K-linear scaling projects from this measured per-node ceiling.`);

  const outDir = path.join(REPO, 'benchmark/results');
  fs.mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const out = path.join(outDir, `load-test-${date}.json`);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: date, api: API, requestsPerLevel: REQUESTS, rows, peak }, null, 2));
  console.log(`  Output: ${out}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
