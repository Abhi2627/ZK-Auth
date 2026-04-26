/**
 * Challenge Service
 *
 * Manages the ZKP authentication challenge lifecycle:
 *   1. Generate a 32-byte cryptographically random nonce.
 *   2. Persist to Redis with 120s TTL (primary fast-path for verification).
 *   3. Persist to PostgreSQL zkp_challenges (audit trail + nullifier correlation).
 *   4. On consumption: atomically delete from Redis and mark PG record CONSUMED.
 *   5. On expiry sweep: mark stale PG records EXPIRED (background job, Phase 5).
 *
 * Security invariants:
 *   - Nonce is single-use: consumed atomically on first successful verify.
 *   - Redis TTL enforces the 120s window; PG is the durable audit record.
 *   - challenge_id is a UUID that the client echoes back — it is NOT secret.
 *     The nonce is the secret entropy; the challenge_id is only a lookup key.
 */

import { prisma } from '../../config/database.js';
import { redis, RedisKeys } from '../../config/redis.js';
import { generateNonce, generateId, toHex } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import {
  AppError,
  ErrorCode,
  NotFoundError,
} from '../../utils/errors.js';
import { env } from '../../config/env.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChallengeRecord {
  challengeId: string;
  nonce: string;        // hex-encoded 32-byte nonce returned to client
  expiresAt: number;    // Unix epoch ms
}

export interface RedisChallengePayload {
  nonce: string;        // hex
  userId: string | null;
  createdAt: number;    // Unix epoch ms
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ChallengeService {
  /**
   * Issue a new challenge.
   *
   * @param userId - Optional: pre-identified user UUID. Null for anonymous
   *                 pre-auth challenges (client may not know their userId yet
   *                 in a pure ZKP flow where commitment_hash is the identifier).
   */
  async issue(userId: string | null = null): Promise<ChallengeRecord> {
    const challengeId = generateId();
    const nonceBytes = generateNonce(32);          // 32-byte raw hex
    const nonceHex = nonceBytes;                   // generateNonce already returns hex
    const now = Date.now();
    const expiresAt = now + env.CHALLENGE_TTL_SECONDS * 1_000;
    const expiresAtDate = new Date(expiresAt);

    // ── 1. Write to Redis (primary TTL enforcement) ──────────────────────────
    const redisPayload: RedisChallengePayload = {
      nonce: nonceHex,
      userId,
      createdAt: now,
    };

    const redisKey = RedisKeys.challenge(challengeId);
    const set = await redis.set(
      redisKey,
      JSON.stringify(redisPayload),
      'EX', env.CHALLENGE_TTL_SECONDS,
      'NX',  // only set if not exists — prevents overwrite race
    );

    if (set === null) {
      // UUID collision is astronomically unlikely but handled defensively
      logger.error({ challengeId }, 'Challenge Redis key collision — retrying');
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'Challenge generation conflict — please retry',
        500,
      );
    }

    // ── 2. Write to PostgreSQL (audit trail) ─────────────────────────────────
    try {
      await prisma.zkpChallenge.create({
        data: {
          id: challengeId,
          userId,
          nonce: Buffer.from(nonceHex, 'hex'),
          status: 'PENDING',
          expiresAt: expiresAtDate,
        },
      });
    } catch (pgErr) {
      // PG write failed — roll back Redis entry to prevent ghost challenges
      await redis.del(redisKey).catch((redisErr) =>
        logger.error({ redisErr, challengeId }, 'Failed to clean up Redis after PG error'),
      );
      logger.error({ pgErr, challengeId }, 'Failed to persist challenge to PostgreSQL');
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'Challenge issuance failed — please retry',
        500,
      );
    }

    logger.info(
      { challengeId, userId, expiresAt: expiresAtDate.toISOString() },
      'Challenge issued',
    );

    return { challengeId, nonce: nonceHex, expiresAt };
  }

  /**
   * Fetch and validate a challenge from Redis.
   * Returns the parsed payload if valid; throws if expired or not found.
   *
   * This is called by ZkpService.verify() before proof verification.
   * We read from Redis (not PG) on the hot path to avoid DB load.
   */
  async fetch(challengeId: string): Promise<RedisChallengePayload> {
    const redisKey = RedisKeys.challenge(challengeId);
    const raw = await redis.get(redisKey);

    if (raw === null) {
      // Key absent from Redis — either expired (TTL elapsed) or never existed
      // Check PG to distinguish expired vs. unknown for a precise error code
      const pgRecord = await prisma.zkpChallenge
        .findUnique({ where: { id: challengeId } })
        .catch(() => null);

      if (pgRecord?.status === 'CONSUMED') {
        throw new AppError(ErrorCode.NULLIFIER_REPLAY, 'Challenge already consumed', 400);
      }
      if (pgRecord?.status === 'EXPIRED' || pgRecord !== null) {
        throw new AppError(ErrorCode.CHALLENGE_EXPIRED, 'Challenge has expired', 400);
      }
      throw new NotFoundError('Challenge');
    }

    const payload = JSON.parse(raw) as RedisChallengePayload;
    return payload;
  }

  /**
   * Atomically consume a challenge after successful proof verification.
   *
   * Two-step:
   *   1. DEL from Redis (prevents any future use of this nonce)
   *   2. Mark PG record CONSUMED with consumedAt timestamp
   *
   * If Redis DEL succeeds but PG update fails, the challenge is still
   * effectively dead (Redis is the authority for active challenges).
   * The PG record will remain PENDING — a background sweep (Phase 5)
   * will reconcile these as CONSUMED based on the nullifier table.
   */
  async consume(challengeId: string): Promise<void> {
    const redisKey = RedisKeys.challenge(challengeId);

    // Step 1: Delete from Redis atomically
    const deleted = await redis.del(redisKey);
    if (deleted === 0) {
      // Already deleted — race condition or double-consume attempt
      throw new AppError(
        ErrorCode.NULLIFIER_REPLAY,
        'Challenge already consumed or expired',
        400,
      );
    }

    // Step 2: Mark PG record CONSUMED (best-effort — don't throw on PG failure)
    await prisma.zkpChallenge
      .update({
        where: { id: challengeId },
        data: {
          status: 'CONSUMED',
          consumedAt: new Date(),
        },
      })
      .catch((err) =>
        logger.warn({ err, challengeId }, 'PG challenge status update failed — reconcile later'),
      );

    logger.info({ challengeId }, 'Challenge consumed');
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const challengeService = new ChallengeService();
