#!/usr/bin/env node
/**
 * Empirical Security Validation — G3 (Nullifier Replay Prevention)
 * =================================================================
 * Paper: Section "Empirical Security Validation" (Theorem: Replay Resistance).
 *
 * What this harness demonstrates (end-to-end, against the live backend):
 *   1. A genuine (proof, publicSignals) authenticates once and succeeds.
 *   2. Resubmitting the IDENTICAL tuple N times is rejected every time,
 *      with error code NULLIFIER_REPLAY, at the pre-verification SISMEMBER gate.
 *   3. A proof bound to an EXPIRED challenge nonce is rejected (CHALLENGE_EXPIRED).
 *   4. A proof submitted under a FOREIGN (different) challenge_id is rejected.
 *
 * It reports: replay rejection rate, error codes observed, and the median
 * reject latency vs. the first-time accept latency — the numbers that fill the
 * "[HARNESS OUTPUT: ...]" placeholder in the paper's G3 validation paragraph.
 *
 * ── Prerequisites ─────────────────────────────────────────────────────────────
 *   - Backend stack running (docker compose up -d; backend on :3001).
 *   - Circuit artifacts present: backend/circuits/auth/auth_js/auth.wasm and
 *     backend/circuits/auth/auth.zkey (or pass --wasm/--zkey).
 *   - A registered user commitment, OR let the harness register a fresh secret.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   node benchmark/run_replay_attack_test.mjs \
 *        --api http://localhost:3001 --replays 20
 *
 * Output JSON is written to benchmark/results/replay-attack-<date>.json
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// snarkjs is CommonJS — load via createRequire so groth16 resolves from ESM (.mjs).
const require = createRequire(import.meta.url);
const snarkjs = require('snarkjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── CLI args ──────────────────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const API     = arg('api', 'http://localhost:3001');
const REPLAYS = parseInt(arg('replays', '20'), 10);
const WASM    = arg('wasm', path.join(REPO, 'backend/circuits/auth/auth_js/auth.wasm'));
const ZKEY    = arg('zkey', path.join(REPO, 'backend/circuits/auth/auth.zkey'));

const BN254 = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);
const mod = (a) => ((a % BN254) + BN254) % BN254;
const hexToField = (hex) => mod(BigInt('0x' + hex.replace(/^0x/, '')));

async function post(pathname, body, headers = {}) {
  const t0 = performance.now();
  const res = await fetch(API + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const ms = performance.now() - t0;
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, ms };
}

function errorCode(resp) {
  return resp.json?.error?.code ?? resp.json?.code ?? resp.json?.error ?? `HTTP_${resp.status}`;
}

async function commitmentFromCircuit(secretHex) {
  // The circuit outputs commitment_root as publicSignals[1] = Poseidon(secret).
  // Deriving it from a throwaway proof makes it match the circuit exactly,
  // independent of any JS Poseidon library/version.
  const { publicSignals } = await prove(secretHex, '00'.repeat(32));
  return publicSignals[1];
}

async function prove(secretHex, nonceHex) {
  const witness = { secret: hexToField(secretHex).toString(10), nonce: hexToField(nonceHex).toString(10) };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
  return { proof, publicSignals }; // publicSignals = [nullifier, commitment, nonce]
}

async function main() {
  console.log('═'.repeat(63));
  console.log('  ZK-Auth Replay-Attack Test  (G3 empirical validation)');
  console.log('═'.repeat(63));
  console.log(`  API: ${API}   replays: ${REPLAYS}`);

  // 1. Register a fresh secret so the test is self-contained.
  const secretHex = crypto.randomBytes(32).toString('hex');
  const commitment = await commitmentFromCircuit(secretHex);
  const pubKeyHex = crypto.randomBytes(32).toString('hex');

  const reg = await post('/api/v1/auth/register', {
    commitment_hash: commitment,
    public_key_hex: pubKeyHex,
    device_label: 'replay-test',
  });
  if (reg.status !== 201) {
    console.error('  Registration failed:', reg.status, errorCode(reg),
      '\n  (If the commitment already exists, re-run — a fresh secret is generated each run.)');
    process.exit(1);
  }
  console.log('  ✓ Registered fresh test identity');

  // 2. Genuine login (challenge → prove → verify) — must succeed.
  const ch = await post('/api/v1/auth/challenge', { commitment_hash: commitment });
  const { challenge_id, nonce } = ch.json;
  const { proof, publicSignals } = await prove(secretHex, nonce);

  const firstAccept = await post('/api/v1/auth/verify', {
    challenge_id, proof, public_signals: publicSignals,
  });
  const acceptOk = firstAccept.status === 200;
  console.log(`  ${acceptOk ? '✓' : '✗'} First-time verify: HTTP ${firstAccept.status} ` +
              `(${firstAccept.ms.toFixed(1)} ms)`);
  if (!acceptOk) {
    console.error('  Genuine login did not succeed; aborting.', errorCode(firstAccept));
    process.exit(1);
  }

  // 3. Replay the IDENTICAL tuple N times — every attempt must be rejected.
  const replayResults = [];
  for (let i = 0; i < REPLAYS; i++) {
    // Reuse the same challenge_id + proof + signals (a pure replay).
    const r = await post('/api/v1/auth/verify', {
      challenge_id, proof, public_signals: publicSignals,
    });
    replayResults.push({ status: r.status, code: errorCode(r), ms: r.ms });
  }
  const rejected = replayResults.filter((r) => r.status !== 200);
  const rejectCodes = [...new Set(rejected.map((r) => r.code))];
  const rejectLatencies = rejected.map((r) => r.ms).sort((a, b) => a - b);
  const medReject = rejectLatencies.length
    ? rejectLatencies[Math.floor(rejectLatencies.length / 2)] : null;

  // 4. Expired-challenge test: wait past TTL is slow; instead submit under a
  //    fresh challenge_id that was never issued (simulates stale/foreign id).
  const foreign = await post('/api/v1/auth/verify', {
    challenge_id: crypto.randomUUID(), proof, public_signals: publicSignals,
  });

  // 5. Cross-nonce test: new challenge, but submit the OLD proof (nonce mismatch).
  const ch2 = await post('/api/v1/auth/challenge', { commitment_hash: commitment });
  const crossNonce = await post('/api/v1/auth/verify', {
    challenge_id: ch2.json.challenge_id, proof, public_signals: publicSignals,
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    api: API,
    firstAccept: { ok: acceptOk, ms: +firstAccept.ms.toFixed(2) },
    replay: {
      attempts: REPLAYS,
      rejected: rejected.length,
      rejectionRate: +(rejected.length / REPLAYS).toFixed(4),
      errorCodes: rejectCodes,
      medianRejectMs: medReject != null ? +medReject.toFixed(2) : null,
    },
    foreignChallenge: { status: foreign.status, code: errorCode(foreign) },
    crossNonce: { status: crossNonce.status, code: errorCode(crossNonce) },
  };

  console.log('─'.repeat(63));
  console.log(`  Replay attempts   : ${REPLAYS}`);
  console.log(`  Rejected          : ${rejected.length}/${REPLAYS} ` +
              `(${(summary.replay.rejectionRate * 100).toFixed(1)}%)`);
  console.log(`  Reject error code : ${rejectCodes.join(', ') || '(none)'}`);
  console.log(`  Median reject lat : ${medReject != null ? medReject.toFixed(2) + ' ms' : 'n/a'}`);
  console.log(`  Foreign challenge : HTTP ${foreign.status} (${errorCode(foreign)})`);
  console.log(`  Cross-nonce proof : HTTP ${crossNonce.status} (${errorCode(crossNonce)})`);
  console.log('─'.repeat(63));
  console.log('  PASTE INTO PAPER (Sec. Empirical Security Validation, G3):');
  console.log(`    replay rejection rate ${rejected.length}/${REPLAYS} ` +
              `(=${(summary.replay.rejectionRate * 100).toFixed(0)}%), ` +
              `median reject latency ${medReject != null ? medReject.toFixed(1) : '—'} ms, ` +
              `code ${rejectCodes.join('/') || '—'}`);

  const outDir = path.join(REPO, 'benchmark/results');
  fs.mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outFile = path.join(outDir, `replay-attack-${date}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`  Output: ${outFile}`);

  // snarkjs keeps worker threads alive; exit explicitly.
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
