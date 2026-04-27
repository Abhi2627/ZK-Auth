/**
 * Disclosure Service — Selective Disclosure Proof Verification
 *
 * ─── Verify-claim flow ────────────────────────────────────────────────────────
 *   1. Load disclosure verification key from memory (seeded at startup).
 *   2. Fetch the credential record to get the stored merkle_root.
 *   3. Assert: credential is ACTIVE, not expired.
 *   4. Assert: the root in publicSignals[0] matches the stored merkle_root.
 *      This prevents a client from submitting a proof for a different tree.
 *   5. Assert: publicSignals[2] (leaf_index) is within valid range.
 *   6. Run snarkjs.groth16.verify(vKey, publicSignals, proof).
 *   7. On success: write audit record to zkp.disclosure_proofs.
 *   8. Return verification result.
 *
 * ─── Public signals layout (matches merkle_disclosure.circom main component) ──
 *   publicSignals[0] — root        (Merkle root of the credential)
 *   publicSignals[1] — threshold   (comparison value for GTE predicate)
 *   publicSignals[2] — leaf_index  (attribute position being proved)
 *
 * ─── T6 Mitigation (Disclosure Linkage) ──────────────────────────────────────
 *   The verifier receives ONLY the root R and the predicate result.
 *   - Root R is re-randomised on each re-issuance (new salts → new leaves → new root).
 *   - Multiple proof submissions for the same credential cannot be linked by an
 *     external observer because the proof π is randomised (Groth16 uses random r, s
 *     in the proof generation step — same witness produces different proofs each time).
 *   - The audit log in zkp.disclosure_proofs is accessible only to the issuer,
 *     not to verifiers. Verifiers receive a boolean result, not the proof or signals.
 */

import path from 'path';
import fs from 'fs';
import { groth16 } from 'snarkjs';
import { prisma } from '../../config/database.js';
import { MerkleService } from './merkle.service.js';
import { sha256, generateId } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import {
  AppError,
  ErrorCode,
  NotFoundError,
} from '../../utils/errors.js';
import { env } from '../../config/env.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DisclosureProofInput {
  /** Groth16 proof object (same shape as auth circuit) */
  proof: {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
    protocol: 'groth16';
    curve: 'bn254';
  };
  /**
   * Public signals from the circuit:
   *   [0] root        — Merkle root commitment
   *   [1] threshold   — comparison value
   *   [2] leaf_index  — attribute position
   */
  publicSignals: [string, string, string];
  /** UUID of the credential being disclosed against */
  credentialId: string;
  /** Human-readable predicate description for the audit log */
  claimedPredicate: string;
  /** Identifier of the verifying party (for audit) */
  verifierId: string;
}

export interface DisclosureResult {
  valid: boolean;
  credentialId: string;
  claimedPredicate: string;
  verifiedAt: Date;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class DisclosureService {
  private _vKey: object | null = null;
  private _vKeyPath: string;

  constructor(vKeyPath: string) {
    this._vKeyPath = path.resolve(vKeyPath);
  }

  // ─── Initialisation ───────────────────────────────────────────────────────

  /**
   * Load disclosure verification key from disk into memory.
   * Called once during server bootstrap alongside zkpService.initialize().
   */
  async initialize(): Promise<void> {
    if (!fs.existsSync(this._vKeyPath)) {
      logger.warn(
        { vKeyPath: this._vKeyPath },
        'Disclosure verification key not found — selective disclosure will be unavailable until circuit is compiled.',
      );
      return;
    }

    try {
      const raw = fs.readFileSync(this._vKeyPath, 'utf8');
      this._vKey = JSON.parse(raw) as object;
      logger.info(
        { vKeyPath: this._vKeyPath },
        'Disclosure verification key loaded into memory',
      );
    } catch (err) {
      logger.fatal({ err, vKeyPath: this._vKeyPath }, 'Failed to load disclosure verification key');
      throw err;
    }
  }

  // ─── Public: verifyClaim ─────────────────────────────────────────────────

  /**
   * Verify a selective disclosure proof and record the audit entry.
   *
   * @throws AppError(SERVICE_UNAVAILABLE) if vKey not loaded
   * @throws NotFoundError                 if credential not found
   * @throws AppError(CREDENTIAL_REVOKED)  if credential is revoked
   * @throws AppError(CREDENTIAL_EXPIRED)  if credential is expired
   * @throws AppError(INVALID_CLAIM_PROOF) if proof is invalid or root mismatch
   */
  async verifyClaim(input: DisclosureProofInput): Promise<DisclosureResult> {
    const { proof, publicSignals, credentialId, claimedPredicate, verifierId } = input;

    // ── 1. Assert vKey is loaded ──────────────────────────────────────────────
    if (this._vKey === null) {
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Disclosure verification service not initialised — circuit artifacts missing',
        503,
      );
    }

    // ── 2. Validate public signals structure ──────────────────────────────────
    if (!Array.isArray(publicSignals) || publicSignals.length !== 3) {
      throw new AppError(
        ErrorCode.INVALID_CLAIM_PROOF,
        'Invalid public signals: expected [root, threshold, leaf_index]',
        400,
      );
    }

    const [proofRoot, , leafIndexStr] = publicSignals;

    // Validate field element format
    if (!/^\d{1,78}$/.test(proofRoot!) || !/^\d+$/.test(leafIndexStr!)) {
      throw new AppError(
        ErrorCode.INVALID_CLAIM_PROOF,
        'Public signals contain invalid field elements',
        400,
      );
    }

    const leafIndex = parseInt(leafIndexStr!, 10);
    if (leafIndex < 0 || leafIndex > 255) {
      throw new AppError(
        ErrorCode.INVALID_CLAIM_PROOF,
        'leaf_index out of valid range [0, 255]',
        400,
      );
    }

    // ── 3. Fetch credential and validate status ───────────────────────────────
    const credential = await prisma.credential.findUnique({
      where: { id: credentialId },
      select: {
        id: true,
        merkleRoot: true,
        status: true,
        expiresAt: true,
        userId: true,
      },
    });

    if (!credential) {
      throw new NotFoundError('Credential');
    }

    if (credential.status === 'REVOKED') {
      throw new AppError(
        ErrorCode.CREDENTIAL_REVOKED,
        'Credential has been revoked',
        400,
      );
    }

    if (
      credential.status === 'EXPIRED' ||
      (credential.expiresAt !== null && credential.expiresAt < new Date())
    ) {
      throw new AppError(
        ErrorCode.CREDENTIAL_EXPIRED,
        'Credential has expired',
        400,
      );
    }

    // ── 4. Assert proof root matches stored merkle_root ───────────────────────
    // Convert stored hex root to decimal field element string for comparison.
    // The circuit outputs roots as decimal field element strings.
    const storedRootBigint = BigInt('0x' + credential.merkleRoot);
    const storedRootDecimal = storedRootBigint.toString(10);

    if (proofRoot !== storedRootDecimal) {
      logger.warn(
        { credentialId, proofRoot, storedRoot: storedRootDecimal },
        'Proof root does not match stored credential root — possible credential substitution attack',
      );
      throw new AppError(
        ErrorCode.INVALID_CLAIM_PROOF,
        'Proof root does not match credential commitment',
        400,
      );
    }

    // ── 5. SnarkJS verification ───────────────────────────────────────────────
    let isValid: boolean;
    try {
      isValid = await groth16.verify(
        this._vKey,
        publicSignals as string[],
        proof,
      );
    } catch (err) {
      logger.warn({ err, credentialId }, 'snarkjs disclosure verify threw — treating as invalid');
      throw new AppError(ErrorCode.INVALID_CLAIM_PROOF, 'Proof verification failed', 400);
    }

    const verifiedAt = new Date();

    // ── 6. Write audit record (regardless of result — audit both outcomes) ────
    await this._writeAuditRecord({
      credentialId,
      verifierId,
      claimedPredicate,
      proofValid: isValid,
      verifiedAt,
      publicSignals,
    });

    if (!isValid) {
      logger.warn({ credentialId, verifierId, claimedPredicate }, 'Disclosure proof invalid');
      throw new AppError(
        ErrorCode.INVALID_CLAIM_PROOF,
        'Selective disclosure proof is not valid',
        400,
      );
    }

    logger.info(
      { credentialId, verifierId, claimedPredicate, leafIndex },
      'Selective disclosure verified successfully',
    );

    return {
      valid: true,
      credentialId,
      claimedPredicate,
      verifiedAt,
    };
  }

  // ─── Private: write audit record ─────────────────────────────────────────

  private async _writeAuditRecord(params: {
    credentialId: string;
    verifierId: string;
    claimedPredicate: string;
    proofValid: boolean;
    verifiedAt: Date;
    publicSignals: string[];
  }): Promise<void> {
    const proofMetadata = {
      // Store hash of public signals — never raw signals in audit log
      signals_hash: sha256(JSON.stringify(params.publicSignals)),
    };

    await prisma.disclosureProof
      .create({
        data: {
          id: generateId(),
          credentialId: params.credentialId,
          verifierId: params.verifierId,
          claimedPredicate: params.claimedPredicate,
          proofValid: params.proofValid,
          verifiedAt: params.verifiedAt,
          proofMetadata,
        },
      })
      .catch((err) =>
        logger.error(
          { err, credentialId: params.credentialId },
          'Failed to write disclosure audit record — non-critical, continuing',
        ),
      );
  }

  get isInitialized(): boolean {
    return this._vKey !== null;
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const disclosureService = new DisclosureService(
  env.DISCLOSURE_CIRCUIT_VKEY_PATH,
);
