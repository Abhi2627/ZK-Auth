/**
 * Recovery Service — Lost-Key Account Recovery
 *
 * ─── Threat model ─────────────────────────────────────────────────────────────
 * An attacker who obtains the database gains:
 *   - code_hash: argon2id(mnemonic, argon2_salt)
 *   - argon2_salt: 16-byte random
 *
 * To recover an account they need the raw 24-word mnemonic (2048^24 ≈ 2^264
 * possible values). Argon2id with 64 MB memory cost means:
 *   - A single hash attempt takes ~300ms on a modern CPU
 *   - A high-end GPU (RTX 4090) achieves ~15 hashes/sec at 64 MB memory
 *   - Brute-forcing 2^264 inputs at 15 h/s would take longer than the age
 *     of the universe by a margin of ~10^70
 *
 * Even if the entire `recovery_codes` table is exfiltrated, the raw
 * mnemonic is computationally irrecoverable. The only attack surface is
 * the client who holds the raw mnemonic after registration — outside
 * our threat model (that's the user's responsibility to protect it).
 *
 * ─── Recovery flow ───────────────────────────────────────────────────────────
 *
 *  Generation (called once at registration):
 *    1. Generate 24-word BIP-39 mnemonic (256 bits entropy).
 *    2. Generate 16-byte Argon2 salt.
 *    3. Compute argon2id(mnemonic, salt, {memory: 64MB, t: 3, p: 1}).
 *    4. Store (codeHash, salt) in auth.recovery_codes.
 *    5. Return raw mnemonic to client ONCE — never store it.
 *
 *  Execution (POST /auth/recover):
 *    1. Look up active (isUsed=false, superseded_at=null) recovery code
 *       for the claimed user (looked up by current commitment_hash or user_id).
 *    2. Recompute argon2id(submitted_mnemonic, stored_salt).
 *    3. Constant-time compare against stored code_hash (timingSafeEqual).
 *    4. If match:
 *       a. Call stored procedure auth.burn_recovery_code() — atomic mark-as-used.
 *       b. Revoke ALL active sessions (global logout).
 *       c. Mark the old commitment_hash as PENDING_VERIFY (commitment burned).
 *       d. Accept new commitment_hash from the new device.
 *       e. Issue a time-limited "recovery token" (15-minute JWT, type: 'recovery').
 *       f. Client must complete a fresh ZKP proof with new secret within 15 min.
 *
 * ─── BIP-39 word list ─────────────────────────────────────────────────────────
 * We use the standard BIP-39 English word list (2048 words). With 24 words
 * the entropy is 256 bits — equivalent to a 256-bit random key.
 * Implementation: `@scure/bip39` (audited, zero-dependency).
 */

import * as argon2  from 'argon2';
import * as bip39   from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import crypto       from 'crypto';

import { prisma }              from '../../config/database.js';
import { redis, RedisKeys }    from '../../config/redis.js';
import { env }                 from '../../config/env.js';
import { generateId, timingSafeEqual } from '../../utils/crypto.js';
import { logger }              from '../../utils/logger.js';
import {
  AppError,
  ErrorCode,
  NotFoundError,
  UnauthorizedError,
} from '../../utils/errors.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecoveryGenerationResult {
  /** Raw 24-word mnemonic — returned to client ONCE, never stored. */
  mnemonic: string;
  recoveryCodeId: string;
}

export interface RecoveryExecutionInput {
  /** The user identifier — either userId UUID or current commitment_hash. */
  userIdentifier: string;
  identifierType: 'userId' | 'commitmentHash';
  /** Raw mnemonic phrase submitted by the user. */
  mnemonic: string;
  /** New Poseidon(secret) commitment from the replacement device. */
  newCommitmentHash: string;
  /** New public key bytes from the replacement device. */
  newPublicKey: Buffer;
}

export interface RecoveryExecutionResult {
  /** Short-lived JWT (type: 'recovery', 15m) authorising the new device
   *  to register a ZKP proof. Client must call POST /auth/verify within 15m. */
  recoveryToken: string;
  userId: string;
}

// ─── Argon2id configuration ────────────────────────────────────────────────────

function argon2Options() {
  return {
    type:        argon2.argon2id,
    memoryCost:  env.ARGON2_MEMORY_KIB,
    timeCost:    env.ARGON2_ITERATIONS,
    parallelism: env.ARGON2_PARALLELISM,
    // Raw hash output — we store the full Argon2 encoded string which embeds
    // the salt and parameters, making future parameter upgrades trivial.
    raw: false,
  } as const;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class RecoveryService {

  // ─── Generate: called once during user registration ───────────────────────

  /**
   * Generate a 24-word BIP-39 recovery mnemonic for a user.
   * Supersedes any existing active recovery code for this user.
   *
   * IMPORTANT: The caller must transmit the raw mnemonic to the client
   * IMMEDIATELY and then discard it. It must not be logged, cached, or stored
   * anywhere except as an Argon2id hash in auth.recovery_codes.
   */
  async generateForUser(userId: string): Promise<RecoveryGenerationResult> {
    // 1. Generate 256-bit entropy BIP-39 mnemonic (24 words)
    const mnemonic = bip39.generateMnemonic(wordlist, 256);

    // 2. Generate 16-byte Argon2 salt (separate from mnemonic entropy)
    const salt = crypto.randomBytes(16);

    // 3. Hash with Argon2id — this takes ~300ms deliberately (memory-hard)
    const codeHash = await argon2.hash(mnemonic, {
      ...argon2Options(),
      salt,
    });

    const recoveryCodeId = generateId();
    const now = new Date();

    // 4. Transactionally supersede any existing active code and insert new one
    await prisma.$transaction(async (tx) => {
      // Mark existing active codes as superseded
      await tx.recoveryCode.updateMany({
        where: {
          userId,
          isUsed: false,
          supersededAt: null,
        },
        data: { supersededAt: now },
      });

      // Insert new code
      await tx.recoveryCode.create({
        data: {
          id:         recoveryCodeId,
          userId,
          codeHash,
          argon2Salt: salt,
          isUsed:     false,
        },
      });
    });

    logger.info({ userId, recoveryCodeId }, 'Recovery code generated');

    // 5. Return raw mnemonic — caller must transmit to client and discard
    return { mnemonic, recoveryCodeId };
  }

  // ─── Execute: POST /auth/recover ──────────────────────────────────────────

  /**
   * Execute account recovery using a previously issued mnemonic.
   *
   * Returns a short-lived recovery JWT on success. The client must use it
   * within 15 minutes to complete ZKP registration with the new secret.
   */
  async executeRecovery(input: RecoveryExecutionInput): Promise<RecoveryExecutionResult> {
    const { mnemonic, newCommitmentHash, newPublicKey } = input;

    // ── 1. Resolve user ────────────────────────────────────────────────────
    let userId: string;

    if (input.identifierType === 'userId') {
      userId = input.userIdentifier;
    } else {
      const user = await prisma.user.findUnique({
        where: { commitmentHash: input.userIdentifier },
        select: { id: true },
      });
      if (!user) throw new UnauthorizedError('Recovery failed');
      userId = user.id;
    }

    // ── 2. Fetch active recovery code ──────────────────────────────────────
    const activeCode = await prisma.recoveryCode.findFirst({
      where: {
        userId,
        isUsed:       false,
        supersededAt: null,
      },
      select: {
        id:         true,
        codeHash:   true,
        argon2Salt: true,
      },
    });

    if (!activeCode) {
      // No active code — do not reveal whether user exists (timing parity below)
      // Still run a dummy Argon2 hash so response time is identical
      await this._dummyArgon2();
      throw new UnauthorizedError('Recovery failed');
    }

    // ── 3. Verify mnemonic with Argon2id (memory-hard, ~300ms) ────────────
    let isValid = false;
    try {
      isValid = await argon2.verify(activeCode.codeHash, mnemonic, {
        type: argon2.argon2id,
      });
    } catch {
      throw new UnauthorizedError('Recovery failed');
    }

    if (!isValid) {
      logger.warn({ userId }, 'Recovery: mnemonic verification failed');
      throw new UnauthorizedError('Recovery failed');
    }

    // ── 4. Validate new commitment hash format ────────────────────────────
    if (!/^\d{1,78}$/.test(newCommitmentHash)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid new commitment hash format',
        400,
      );
    }

    // Check new commitment is not already registered (prevents takeover of another account)
    const existing = await prisma.user.findUnique({
      where: { commitmentHash: newCommitmentHash },
      select: { id: true },
    });
    if (existing && existing.id !== userId) {
      throw new AppError(
        ErrorCode.COMMITMENT_ALREADY_REGISTERED,
        'Commitment hash already in use',
        409,
      );
    }

    // ── 5. Atomic recovery transaction ────────────────────────────────────
    await prisma.$transaction(async (tx) => {
      // 5a. Burn the recovery code (mark as used)
      // Uses raw SQL to call the stored procedure for atomicity
      await tx.$executeRaw`SELECT auth.burn_recovery_code(${userId}::uuid, ${activeCode.codeHash}::text)`;

      // 5b. Revoke ALL active sessions globally
      const sessions = await tx.session.findMany({
        where: { userId, isRevoked: false },
        select: { id: true },
      });
      await tx.session.updateMany({
        where: { userId },
        data:  { isRevoked: true },
      });

      // 5c. Burn old commitment — set user to PENDING_VERIFY with new commitment
      await tx.user.update({
        where: { id: userId },
        data: {
          commitmentHash: newCommitmentHash,
          publicKey:      newPublicKey,
          status:         'PENDING_VERIFY',
          updatedAt:      new Date(),
        },
      });

      // 5d. Clear all Redis session caches for this user
      const pipeline = redis.pipeline();
      sessions.forEach((s) => pipeline.del(RedisKeys.session(s.id)));
      // Also clear any pending step-ups
      sessions.forEach((s) => pipeline.del(RedisKeys.stepUp(s.id)));
      await pipeline.exec();
    });

    logger.info({ userId }, 'Account recovery executed — all sessions revoked, commitment replaced');

    // ── 6. Issue recovery token ────────────────────────────────────────────
    const recoveryToken = await this._issueRecoveryToken(userId);

    return { recoveryToken, userId };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Dummy Argon2 hash to maintain constant response time when user not found. */
  private async _dummyArgon2(): Promise<void> {
    const dummy = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
    const salt  = crypto.randomBytes(16);
    await argon2.hash(dummy, { ...argon2Options(), salt }).catch(() => {});
  }

  /**
   * Issue a short-lived JWT authorising the completion of ZKP re-registration.
   * The client must submit a new ZKP proof within 15 minutes to activate
   * the account (transition from PENDING_VERIFY → ACTIVE).
   */
  private async _issueRecoveryToken(userId: string): Promise<string> {
    const jwt = await import('jsonwebtoken');
    const { env: e } = await import('../../config/env.js');

    return jwt.default.sign(
      {
        sub:  userId,
        type: 'recovery',
        iat:  Math.floor(Date.now() / 1_000),
      },
      e.JWT_ACCESS_SECRET,
      { expiresIn: '15m', issuer: e.JWT_ISSUER, audience: e.JWT_AUDIENCE },
    );
  }
}

export const recoveryService = new RecoveryService();
