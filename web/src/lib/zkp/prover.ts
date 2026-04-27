/**
 * Client-side ZKP Prover — SnarkJS Groth16 in the browser
 *
 * Uses snarkjs.groth16.fullProve() with WASM circuit artifacts
 * served from the Next.js /public/circuits/ directory.
 *
 * ─── Why a Web Worker ─────────────────────────────────────────────────────────
 * Groth16 proof generation on BN254 takes 300ms–2s in WASM depending on device.
 * Running this on the main thread would cause visible UI jank and block React
 * rendering, event handlers, and the telemetry WebSocket.
 *
 * We use a Web Worker to move all heavy computation off the main thread:
 *   main thread → postMessage(witnessInput) → Worker
 *   Worker       → snarkjs.groth16.fullProve() → postMessage(result) → main thread
 *
 * The worker script is inlined as a Blob URL so we don't need a separate
 * /public/worker.js file. The Blob approach is compatible with Next.js App
 * Router without additional webpack configuration.
 *
 * ─── Fallback ─────────────────────────────────────────────────────────────────
 * If Web Workers are unavailable (SSR, restricted environments), we fall back
 * to running snarkjs directly on the main thread with a warning. This maintains
 * correctness at the cost of potential UI blocking.
 *
 * ─── Artifact paths ───────────────────────────────────────────────────────────
 * /public/circuits/auth/auth.wasm  — compiled circuit WASM
 * /public/circuits/auth/auth.zkey  — final proving key (after Phase 2 ceremony)
 * These are large files (auth.zkey can be 10–100MB). In production they should
 * be served with Cache-Control: immutable and a content-hash in the filename.
 */

import type { AuthWitnessInput } from './witness.js';
import type { Groth16Proof } from '@zk-auth/types';

// Circuit artifact paths (relative to Next.js /public directory)
const WASM_PATH = '/circuits/auth/auth.wasm';
const ZKEY_PATH = '/circuits/auth/auth.zkey';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProveResult {
  proof: Groth16Proof;
  /** [nullifier_hash, commitment_root] as decimal field element strings */
  publicSignals: [string, string];
}

// ─── Worker script source ─────────────────────────────────────────────────────
// Inlined as a template literal — bundled into the main JS chunk by webpack.
// The worker imports snarkjs from a CDN-compatible path. In production,
// replace the importScripts URL with your own hosted copy.

const WORKER_SCRIPT = `
importScripts('https://cdn.jsdelivr.net/npm/snarkjs@0.7.4/build/snarkjs.min.js');

self.onmessage = async function(e) {
  const { witnessInput, wasmPath, zkeyPath, id } = e.data;
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      witnessInput,
      wasmPath,
      zkeyPath
    );
    self.postMessage({ id, proof, publicSignals, error: null });
  } catch (err) {
    self.postMessage({ id, proof: null, publicSignals: null, error: err.message });
  }
};
`;

// ─── Worker pool ──────────────────────────────────────────────────────────────
// We maintain a single reusable worker. Proof generation is sequential
// (one challenge at a time per user), so a pool of 1 is sufficient.
// The worker is created lazily on first use and terminated on page unload.

let _worker: Worker | null = null;
let _workerBlobUrl: string | null = null;
let _pendingProofs = new Map<
  string,
  {
    resolve: (result: ProveResult) => void;
    reject: (err: Error) => void;
  }
>();

function getWorker(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;

  if (_worker !== null) return _worker;

  try {
    const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
    _workerBlobUrl = URL.createObjectURL(blob);
    _worker = new Worker(_workerBlobUrl);

    _worker.onmessage = (e: MessageEvent) => {
      const { id, proof, publicSignals, error } = e.data as {
        id: string;
        proof: Groth16Proof | null;
        publicSignals: string[] | null;
        error: string | null;
      };

      const pending = _pendingProofs.get(id);
      if (!pending) return;
      _pendingProofs.delete(id);

      if (error || !proof || !publicSignals) {
        pending.reject(new Error(error ?? 'Proof generation failed'));
        return;
      }

      pending.resolve({
        proof,
        publicSignals: [publicSignals[0]!, publicSignals[1]!],
      });
    };

    _worker.onerror = (e: ErrorEvent) => {
      // Propagate worker error to all pending proofs
      const err = new Error(`Worker error: ${e.message}`);
      _pendingProofs.forEach(({ reject }) => reject(err));
      _pendingProofs.clear();
      // Reset worker so next call creates a fresh one
      _worker = null;
    };

    // Clean up worker and blob URL on page unload
    window.addEventListener('unload', () => {
      _worker?.terminate();
      if (_workerBlobUrl) URL.revokeObjectURL(_workerBlobUrl);
    });

    return _worker;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a Groth16 proof for the auth circuit.
 *
 * Runs in a Web Worker to avoid blocking the main thread.
 * Falls back to main-thread execution if Workers are unavailable.
 *
 * @param witnessInput — { nonce, secret } as decimal field element strings
 * @returns ProveResult with proof and [nullifier_hash, commitment_root]
 */
export async function generateAuthProof(
  witnessInput: AuthWitnessInput,
): Promise<ProveResult> {
  const worker = getWorker();

  if (worker !== null) {
    return generateInWorker(worker, witnessInput);
  }

  // Fallback: main thread (blocks UI — acceptable for SSR/non-browser contexts)
  return generateOnMainThread(witnessInput);
}

async function generateInWorker(
  worker: Worker,
  witnessInput: AuthWitnessInput,
): Promise<ProveResult> {
  return new Promise<ProveResult>((resolve, reject) => {
    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      _pendingProofs.delete(id);
      reject(new Error('Proof generation timed out after 30s'));
    }, 30_000);

    _pendingProofs.set(id, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject:  (err)    => { clearTimeout(timeout); reject(err); },
    });

    worker.postMessage({ witnessInput, wasmPath: WASM_PATH, zkeyPath: ZKEY_PATH, id });
  });
}

async function generateOnMainThread(
  witnessInput: AuthWitnessInput,
): Promise<ProveResult> {
  if (typeof window === 'undefined') {
    throw new Error('ZKP proof generation requires a browser environment');
  }

  console.warn('[ZK-Auth] Generating proof on main thread — UI may be unresponsive');

  // Dynamic import of snarkjs (Next.js code-splits this automatically)
  const { groth16 } = await import('snarkjs');

  const { proof, publicSignals } = await groth16.fullProve(
    witnessInput,
    WASM_PATH,
    ZKEY_PATH,
  );

  return {
    proof: proof as Groth16Proof,
    publicSignals: [publicSignals[0]!, publicSignals[1]!],
  };
}

/**
 * Preload WASM and zkey files into the browser cache.
 * Call this on login page mount so the files are cached before the user
 * clicks "authenticate" — proof generation starts immediately without a
 * network round-trip for the artifacts.
 */
export async function preloadCircuitArtifacts(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await Promise.all([
      fetch(WASM_PATH, { cache: 'force-cache' }),
      fetch(ZKEY_PATH,  { cache: 'force-cache' }),
    ]);
  } catch {
    // Preload failure is non-fatal — prove() will still work, just slower
    console.warn('[ZK-Auth] Circuit artifact preload failed — will fetch on demand');
  }
}
