/**
 * Nullifier Service — T4 Mitigation: Two-Phase Atomic Nullifier Check
 *
 * A nullifier is H(secret || nonce), the ZK circuit's public output.
 * It proves a specific secret-nonce pair was used without revealing either.
 * Once recorded, the same nullifier MUST NEVER be accepted again.
 *
 * Attack surface: without atomicity, two concurrent requests with the same
 * proof could both pass a sequential "does nullifier exist?" check before
 * either writes the record. This is the double-spend race condition (T4).
 *
 * Mitigation — strict two-phase protocol:
 *
 *   Phase A — Redis atomic gate (SADD on the global nullifier SET):
 *     SADD returns 1 → member was NEW → we are the first → proceed.
 *     SADD returns 0 → member already exists → REPLAY ATTACK → reject immediately.
 *     Redis SADD is single-threaded and atomic; no two callers can both get 1.
 *
 *   Phase B — PostgreSQL durable write (INSERT with unique constraint):
 *     If the INSERT succeeds → done.
 *     If the INSERT violates the unique constraint (concurrent write won PG race
 *     but Redis somehow didn't catch it — e.g., Redis failover during the window):
 *       → Roll back: SREM the Redis entry, reject the request.
 *     If PG is unreachable:
 *       → SREM the Redis entry (do not leave a Redis-only nullifier that has
 *          no durable backing), re-throw. The caller will reject the request.
 *
 *   Additionally: a short distributed lock on the specific nullifier hash
 *   serialises the rare case of two concurrent requests with identical proofs
 *   arriving simultaneously before either Redis write completes.
 *
 * Invariant: A nullifier is considered "spent" if AND ONLY IF it exists in
 * BOTH Redis AND PostgreSQL. The Redis entry provides sub-millisecond future
 * checks; PG provides durability across Redis restarts.
 */

import { prisma } from '../../config/database.js';
import { redis, RedisKeys } from '../../config/redis.js';
import { logger } from '../../utils/logger.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { env } from '../../config/env.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NullifierRegistration {
  nullifierHash: string;   // hex string — the ZK public signal
  userId: string;          // UUID
  challengeId: string;     // UUID — links nullifier to the consumed challenge
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class NullifierService {
  /**
   * Check existence of a nullifier (fast-path, Redis only).
   * Used as a pre-verification guard before running the expensive
   * SnarkJS verifier — fail fast if already spent.
   */
  async exists(nullifierHash: string): Promise<boolean> {
    const isMember = await redis.sismember(
      RedisKeys.nullifiers(),
      nullifierHash,
    );
    return isMember === 1;
  }

  /**
   * Register a nullifier with strict two-phase atomicity.
   *
   * @throws AppError(NULLIFIER_REPLAY)     if nullifier already spent (Phase A)
   * @throws AppError(NULLIFIER_REPLAY)     if PG unique constraint violated (Phase B race)
   * @throws AppError(INTERNAL_ERROR)       if PG is unreachable (rolled back cleanly)
   */
  async register(registration: NullifierRegistration): Promise<void> {
    const { nullifierHash, userId, challengeId } = registration;

    // ── Distributed lock: serialise concurrent identical-nullifier requests ──
    // Lock TTL = NULLIFIER_LOCK_TTL_SECONDS (default 5s).
    // If we cannot acquire the lock, another request is mid-flight for this
    // exact nullifier — treat as replay.
    const lockKey = RedisKeys.nullifierLock(nullifierHash);
    const lockAcquired = await redis.set(
      lockKey,
      '1',
      'EX', env.NULLIFIER_LOCK_TTL_SECONDS,
      'NX',
    );

    if (lockAcquired === null) {
      logger.warn({ nullifierHash, userId }, 'Nullifier lock contention — rejecting as replay');
      throw new AppError(
        ErrorCode.NULLIFIER_REPLAY,
        'Proof replay detected',
        400,
      );
    }

    try {
      await this._twoPhaseRegister(nullifierHash, userId, challengeId);
    } finally {
      // Always release the lock — whether success or failure.
      // On success: lock is redundant (nullifier is now in the permanent SET).
      // On failure: release allows legitimate retry with a new challenge/proof.
      await redis.del(lockKey).catch((err) =>
        logger.error({ err, nullifierHash }, 'Failed to release nullifier lock — will expire naturally'),
      );
    }
  }

  // ─── Private: Two-phase register ──────────────────────────────────────────

  private async _twoPhaseRegister(
    nullifierHash: string,
    userId: string,
    challengeId: string,
  ): Promise<void> {
    // ── Phase A: Redis SADD (atomic gate) ────────────────────────────────────
    const addResult = await redis.sadd(
      RedisKeys.nullifiers(),
      nullifierHash,
    );

    if (addResult === 0) {
      // SADD returns 0 when member already existed in the SET.
      // This is the fast-path replay rejection — no DB hit needed.
      logger.warn(
        { nullifierHash, userId },
        'Nullifier replay rejected at Redis gate (Phase A)',
      );
      throw new AppError(
        ErrorCode.NULLIFIER_REPLAY,
        'Proof replay detected',
        400,
      );
    }

    // SADD returned 1 → we are the first → proceed to Phase B.

    // ── Phase B: PostgreSQL durable INSERT ───────────────────────────────────
    try {
      await prisma.nullifier.create({
        data: {
          nullifierHash,
          userId,
          challengeId,
          recordedAt: new Date(),
        },
      });

      logger.info(
        { nullifierHash, userId, challengeId },
        'Nullifier registered (both phases complete)',
      );
    } catch (pgErr: unknown) {
      // Determine if this is a unique-constraint violation (P2002 in Prisma)
      const isUniqueViolation =
        typeof pgErr === 'object' &&
        pgErr !== null &&
        'code' in pgErr &&
        (pgErr as { code: string }).code === 'P2002';

      if (isUniqueViolation) {
        // Extremely rare: Redis SADD passed (no entry in SET) but PG already
        // has a row. Possible after a Redis flush/failover without PG rollback.
        // Roll back the Redis entry — PG is the ground truth here.
        logger.error(
          { nullifierHash, userId },
          'Nullifier PG unique violation despite Redis miss — Redis/PG desync detected. Rolling back.',
        );
        await this._rollbackRedis(nullifierHash);
        throw new AppError(
          ErrorCode.NULLIFIER_REPLAY,
          'Proof replay detected',
          400,
        );
      }

      // PG unreachable or unexpected error — roll back Redis SADD so this
      // nullifier hash is not permanently "spent" without a durable record.
      logger.error(
        { pgErr, nullifierHash, userId },
        'Nullifier PG write failed — rolling back Redis SADD',
      );
      await this._rollbackRedis(nullifierHash);

      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'Nullifier registration failed — please retry',
        500,
      );
    }
  }

  // ─── Private: Roll back Redis SADD ────────────────────────────────────────

  private async _rollbackRedis(nullifierHash: string): Promise<void> {
    const removed = await redis
      .srem(RedisKeys.nullifiers(), nullifierHash)
      .catch((err) => {
        logger.error(
          { err, nullifierHash },
          'CRITICAL: Failed to roll back Redis SADD — nullifier may be permanently marked spent without PG backing. Manual reconciliation required.',
        );
        return 0;
      });

    if (removed === 1) {
      logger.info({ nullifierHash }, 'Redis SADD rolled back successfully');
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const nullifierService = new NullifierService();
