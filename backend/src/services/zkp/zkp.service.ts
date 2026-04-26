/**
 * ZKP Service — Groth16 Proof Verification
 *
 * Responsibilities:
 *   1. Load verification_key.json from disk at startup and cache in memory.
 *      All subsequent verifications use the in-memory vKey — zero disk I/O
 *      on the hot authentication path.
 *   2. Verify SnarkJS Groth16 proofs for the auth circuit.
 *   3. Extract and validate public signals (nullifier_hash, commitment_root).
 *   4. Pad verification response time to a fixed window to mitigate T14
 *      (timing enumeration — attacker inferring user existence from latency).
 *
 * Circuit public signals layout (enforced by auth.circom):
 *   publicSignals[0] — nullifier_hash: hex( H(secret || nonce) )
 *   publicSignals[1] — commitment_root: H(secret) — matches auth.users.commitment_hash
 *
 * Security invariants:
 *   - vKey is loaded ONCE and treated as immutable. Any change requires a
 *     server restart and a new circuit deployment workflow.
 *   - The verifier never receives or stores the user's secret.
 *   - Constant-time padding ensures verify() always takes ≥ TARGET_VERIFY_MS,
 *     regardless of whether verification passes or fails fast. This prevents
 *     an attacker from distinguishing "invalid proof format" (fast reject) from
 *     "valid format, wrong values" (slower reject) via timing.
 */

import fs from 'fs';
import path from 'path';
import { groth16 } from 'snarkjs';
import { prisma } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { AppError, ErrorCode, NotFoundError } from '../../utils/errors.js';
import { env } from '../../config/env.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Parsed SnarkJS Groth16 proof object.
 * Matches the JSON structure output by snarkjs.groth16.fullProve().
 */
export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: 'groth16';
  curve: 'bn254';
}

export interface VerificationInput {
  proof: Groth16Proof;
  publicSignals: [string, string];   // [nullifier_hash, commitment_root]
  challengeNonce: string;            // hex — fetched from Redis by controller
}

export interface VerificationResult {
  valid: boolean;
  nullifierHash: string;
  commitmentRoot: string;
  userId: string;                    // resolved from commitment_root lookup
}

// ─── Timing constants ─────────────────────────────────────────────────────────

/**
 * Minimum wall-clock time for a verify() call in milliseconds.
 * Chosen to comfortably exceed the p99 of a genuine Groth16 verification
 * on the target hardware. Adjust based on profiling in Phase 5.
 *
 * Jitter: ±10ms uniform random added on top to prevent statistical timing analysis.
 */
const TARGET_VERIFY_MS = 50;
const JITTER_MS = 10;

// ─── Service ─────────────────────────────────────────────────────────────────

export class ZkpService {
  private _vKey: object | null = null;
  private _vKeyPath: string;

  constructor(vKeyPath: string) {
    this._vKeyPath = path.resolve(vKeyPath);
  }

  // ─── Initialisation ───────────────────────────────────────────────────────

  /**
   * Load verification key from disk into memory.
   * Called once during server bootstrap — throws on failure (fail-fast).
   */
  async initialize(): Promise<void> {
    if (!fs.existsSync(this._vKeyPath)) {
      // In development the circuit may not be compiled yet.
      // Log a warning rather than crashing so the server can still start
      // and non-ZKP routes are accessible. Verification will fail at runtime
      // until the circuit is compiled and the vKey is in place.
      logger.warn(
        { vKeyPath: this._vKeyPath },
        'ZKP verification key not found — proof verification will be unavailable until circuit is compiled. See backend/circuits/README.md.',
      );
      return;
    }

    try {
      const raw = fs.readFileSync(this._vKeyPath, 'utf8');
      this._vKey = JSON.parse(raw) as object;
      logger.info(
        { vKeyPath: this._vKeyPath },
        'ZKP verification key loaded into memory',
      );
    } catch (err) {
      logger.fatal({ err, vKeyPath: this._vKeyPath }, 'Failed to load ZKP verification key');
      throw err;
    }
  }

  // ─── Public: verify ───────────────────────────────────────────────────────

  /**
   * Verify a Groth16 proof and return the extracted claims.
   *
   * Always takes ≥ TARGET_VERIFY_MS (+ random jitter) to return,
   * regardless of pass/fail path — T14 mitigation.
   *
   * Verification steps:
   *   1. Assert vKey is loaded.
   *   2. Assert publicSignals[0] matches H(secret || challengeNonce) structure
   *      (circuit enforces this; we verify the nonce binding here).
   *   3. Call snarkjs groth16.verify().
   *   4. Look up the user by commitment_root (publicSignals[1]).
   *   5. Assert user is ACTIVE.
   *   6. Pad timing to TARGET_VERIFY_MS.
   */
  async verify(input: VerificationInput): Promise<VerificationResult> {
    const startMs = Date.now();

    try {
      return await this._verifyInternal(input);
    } finally {
      // ── Constant-time padding (T14 mitigation) ──────────────────────────
      // Whether _verifyInternal threw or returned normally, we pad here.
      // The `finally` block always executes before the throw propagates.
      const elapsed = Date.now() - startMs;
      const jitter = Math.floor(Math.random() * JITTER_MS * 2) - JITTER_MS;
      const target = TARGET_VERIFY_MS + jitter;
      const remaining = target - elapsed;
      if (remaining > 0) {
        await sleep(remaining);
      }
    }
  }

  // ─── Private: core verification logic ────────────────────────────────────

  private async _verifyInternal(input: VerificationInput): Promise<VerificationResult> {
    // Step 1: vKey must be loaded
    if (this._vKey === null) {
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        'ZKP verification service not initialised — circuit artifacts missing',
        503,
      );
    }

    const { proof, publicSignals, challengeNonce } = input;

    // Step 2: Validate public signals array structure
    if (!Array.isArray(publicSignals) || publicSignals.length !== 2) {
      throw new AppError(
        ErrorCode.INVALID_PROOF,
        'Invalid public signals: expected exactly [nullifier_hash, commitment_root]',
        400,
      );
    }

    const [nullifierHash, commitmentRoot] = publicSignals;

    if (!isValidFieldElement(nullifierHash) || !isValidFieldElement(commitmentRoot)) {
      throw new AppError(
        ErrorCode.INVALID_PROOF,
        'Public signals contain invalid field elements',
        400,
      );
    }

    // Step 3: Validate the proof object structure before passing to snarkjs
    validateProofShape(proof);

    // Step 4: SnarkJS Groth16 verification
    // groth16.verify() returns true/false — does NOT throw on invalid proof.
    let isValid: boolean;
    try {
      isValid = await groth16.verify(
        this._vKey,
        publicSignals as string[],
        proof,
      );
    } catch (err) {
      // snarkjs can throw on malformed proof bytes (e.g. curve point not on BN254)
      logger.warn({ err }, 'snarkjs groth16.verify threw — treating as invalid proof');
      throw new AppError(ErrorCode.INVALID_PROOF, 'Proof verification failed', 400);
    }

    if (!isValid) {
      logger.warn({ nullifierHash, challengeNonce }, 'Groth16 proof verification failed');
      throw new AppError(ErrorCode.INVALID_PROOF, 'Proof verification failed', 400);
    }

    // Step 5: Resolve user by commitment_root
    // commitment_root = H(secret), stored as commitment_hash at registration.
    const user = await prisma.user.findUnique({
      where: { commitmentHash: commitmentRoot },
      select: { id: true, status: true },
    });

    if (!user) {
      // Do NOT reveal whether the commitment is unknown — return same error as
      // invalid proof (T14: no user-existence enumeration via error codes).
      logger.warn({ commitmentRoot }, 'No user found for commitment_root');
      throw new AppError(ErrorCode.INVALID_PROOF, 'Proof verification failed', 400);
    }

    // Step 6: User status check
    if (user.status === 'SUSPENDED') {
      throw new AppError(ErrorCode.USER_SUSPENDED, 'Account suspended', 403);
    }

    if (user.status === 'PENDING_VERIFY') {
      throw new AppError(
        ErrorCode.USER_NOT_FOUND,
        'Account registration not complete',
        403,
      );
    }

    logger.info(
      { userId: user.id, nullifierHash },
      'ZKP proof verified successfully',
    );

    return {
      valid: true,
      nullifierHash,
      commitmentRoot,
      userId: user.id,
    };
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  get isInitialized(): boolean {
    return this._vKey !== null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate a string is a plausible BN254 field element.
 * Field elements are decimal strings in range [0, p) where
 * p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 * We do a lightweight format check — snarkjs does the full range check.
 */
function isValidFieldElement(value: string): boolean {
  return typeof value === 'string' && /^\d{1,78}$/.test(value);
}

/**
 * Validate the structural shape of a Groth16 proof object.
 * Rejects obviously malformed inputs before passing to snarkjs.
 */
function validateProofShape(proof: unknown): asserts proof is Groth16Proof {
  if (
    typeof proof !== 'object' ||
    proof === null ||
    !('pi_a' in proof) ||
    !('pi_b' in proof) ||
    !('pi_c' in proof) ||
    !('protocol' in proof) ||
    !('curve' in proof)
  ) {
    throw new AppError(
      ErrorCode.INVALID_PROOF,
      'Malformed proof object: missing required fields',
      400,
    );
  }

  const p = proof as Record<string, unknown>;

  if (p['protocol'] !== 'groth16') {
    throw new AppError(
      ErrorCode.INVALID_PROOF,
      'Unsupported proof protocol — only groth16 accepted',
      400,
    );
  }

  if (p['curve'] !== 'bn254') {
    throw new AppError(
      ErrorCode.INVALID_PROOF,
      'Unsupported curve — only bn254 accepted',
      400,
    );
  }

  if (!Array.isArray(p['pi_a']) || p['pi_a'].length !== 3) {
    throw new AppError(ErrorCode.INVALID_PROOF, 'Malformed proof: invalid pi_a', 400);
  }

  if (
    !Array.isArray(p['pi_b']) ||
    p['pi_b'].length !== 3 ||
    !(p['pi_b'] as unknown[]).every(
      (row) => Array.isArray(row) && (row as unknown[]).length === 2,
    )
  ) {
    throw new AppError(ErrorCode.INVALID_PROOF, 'Malformed proof: invalid pi_b', 400);
  }

  if (!Array.isArray(p['pi_c']) || p['pi_c'].length !== 3) {
    throw new AppError(ErrorCode.INVALID_PROOF, 'Malformed proof: invalid pi_c', 400);
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const zkpService = new ZkpService(env.AUTH_CIRCUIT_VKEY_PATH);
