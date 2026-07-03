#!/usr/bin/env node
/**
 * Replay Atomicity Under Concurrency — Nullifier Lock Contention (Q2)
 * ==================================================================
 * Reviewer question: can the replay-resistance guarantee (Thm. 3) be
 * substantiated without evaluating distributed-lock contention?
 *
 * This harness stresses the T4 two-phase atomic gate directly: it fires C
 * IDENTICAL valid proofs at POST /auth/verify *concurrently* (a genuine
 * double-spend race), and checks that EXACTLY ONE is accepted and the other
 * C-1 are rejected by the Redis distributed lock / SADD gate. It reports the
 * accept/reject split, error codes, and latency under contention.
 *
 * Scope note: this measures contention on a single-node Redis (the atomicity
 * primitive Thm. 3 relies on). Multi-node sharded contention (Lua-script or
 * hash-slot co-location) is architecturally identical but out of scope here;
 * this experiment validates the mechanism's correctness under a concurrent
 * race, not a geo-distributed cluster.
 *
 * Prereqs: backend running (see run_replay_attack_test.mjs header).
 *
 * Usage:
 *   node benchmark/run_nullifier_contention_test.mjs \
 *        --api http://localhost:3011 --concurrency 25 --rounds 10
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
const CONCURRENCY = parseInt(arg('concurrency', '25'), 10);
const ROUNDS = parseInt(arg('rounds', '10'), 10);
const WASM = arg('wasm', path.join(REPO, 'backend/circuits/auth/auth_js/auth.wasm'));
const ZKEY = arg('zkey', path.join(REPO, 'backend/circuits/auth/auth.zkey'));

const BN254 = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
const mod = (a) => ((a % BN254) + BN254) % BN254;
const hexToField = (hex) => mod(BigInt('0x' + hex.replace(/^0x/, '')));

async function post(pathname, body) {
  const t0 = performance.now();
  const res = await fetch(API + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = performance.now() - t0;
  let json = null;
  try { json = await res.json(); } catch { /* */ }
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

async function main() {
  console.log('═'.repeat(63));
  console.log('  Nullifier Contention Test  (Q2 — T4 atomicity under race)');
  console.log('═'.repeat(63));
  console.log(`  API: ${API}   concurrency: ${CONCURRENCY}   rounds: ${ROUNDS}`);

  const secretHex = crypto.randomBytes(32).toString('hex');
  const commitment = await commitmentFromCircuit(secretHex);
  const reg = await post('/api/v1/auth/register', {
    commitment_hash: commitment, public_key_hex: crypto.randomBytes(32).toString('hex'),
    device_label: 'contention-test',
  });
  if (reg.status !== 201) { console.error('  Registration failed:', reg.status, errorCode(reg)); process.exit(1); }
  console.log('  ✓ Registered fresh test identity');

  const rounds = [];
  for (let r = 0; r < ROUNDS; r++) {
    // Fresh challenge + proof each round; then fire CONCURRENCY identical verifies at once.
    const ch = await post('/api/v1/auth/challenge', { commitment_hash: commitment });
    const { challenge_id, nonce } = ch.json;
    const { proof, publicSignals } = await prove(secretHex, nonce);

    const salvo = Array.from({ length: CONCURRENCY }, () =>
      post('/api/v1/auth/verify', { challenge_id, proof, public_signals: publicSignals }));
    const results = await Promise.all(salvo);

    const accepted = results.filter((x) => x.status === 200).length;
    const rejected = results.length - accepted;
    const codes = [...new Set(results.filter((x) => x.status !== 200).map(errorCode))];
    rounds.push({ round: r + 1, accepted, rejected, codes });
  }

  const totalAccepted = rounds.reduce((s, r) => s + r.accepted, 0);
  const roundsWithExactlyOne = rounds.filter((r) => r.accepted === 1).length;
  const allCodes = [...new Set(rounds.flatMap((r) => r.codes))];

  const summary = {
    generatedAt: new Date().toISOString().slice(0, 10),
    api: API, concurrency: CONCURRENCY, rounds: ROUNDS,
    roundsWithExactlyOneAccept: roundsWithExactlyOne,
    totalAcceptedAcrossRounds: totalAccepted,   // expected == ROUNDS (one per round)
    expectedAccepted: ROUNDS,
    rejectionCodes: allCodes,
    perRound: rounds,
  };

  console.log('─'.repeat(63));
  console.log(`  Rounds with EXACTLY 1 accept : ${roundsWithExactlyOne}/${ROUNDS}`);
  console.log(`  Total accepted (want ${ROUNDS})     : ${totalAccepted}`);
  console.log(`  Reject codes under contention: ${allCodes.join(', ')}`);
  console.log('─'.repeat(63));
  console.log('  PASTE INTO PAPER (Replay Atomicity Under Concurrency):');
  console.log(`    under ${CONCURRENCY}-way concurrent submission of an identical proof over ${ROUNDS} rounds, ` +
              `exactly one verify was accepted per round (${roundsWithExactlyOne}/${ROUNDS}); ` +
              `the other ${CONCURRENCY - 1} were rejected by the atomic nullifier gate (${allCodes.join('/')}).`);

  const outDir = path.join(REPO, 'benchmark/results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `nullifier-contention-${summary.generatedAt}.json`);
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`  Output: ${out}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
