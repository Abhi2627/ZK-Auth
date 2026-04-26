/**
 * Session Service — JWT Issuance & Secure Token Rotation
 *
 * Responsibilities:
 *   1. Issue a short-lived access token (15m) and long-lived refresh token (7d).
 *   2. Store SHA-256(refresh_token) in PostgreSQL — the raw token is NEVER
 *      written to any persistent store.
 *   3. Initialise session risk state in Redis for sub-millisecond reads by
 *      the API gateway on every authenticated request.
 *   4. Implement secure refresh-token rotation:
 *        - Verify the incoming refresh token against the stored hash.
 *        - Revoke the old session row (set is_revoked = true).
 *        - Issue a fresh token pair and create a new session row.
 *        - This limits the blast radius of a stolen refresh token to one use.
 *   5. Revoke individual sessions or all sessions for a user (logout-all).
 *
 * Token design:
 *   Access token (JWT):
 *     - Payload: { sub: userId, sid: sessionId, risk: RiskLevel, type: 'access' }
 *     - Signed with JWT_ACCESS_SECRET (HS256)
 *     - TTL: 15 minutes — short enough that a stolen token has limited utility
 *
 *   Refresh token (JWT):
 *     - Payload: { sub: userId, sid: sessionId, jti: refreshId, type: 'refresh' }
 *     - Signed with JWT_REFRESH_SECRET (HS256 — DIFFERENT key from access)
 *     - TTL: 7 days
 *     - Stored as SHA-256 hash in auth.sessions.refresh_token_hash
 *     - Delivered via HttpOnly Secure cookie (web) or secure storage (mobile)
 */

import jwt from 'jsonwebtoken';
import { prisma } from '../../config/database.js';
import { redis, RedisKeys } from '../../config/redis.js';
import { sha256, generateId } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import {
  AppError,
  ErrorCode,
  UnauthorizedError,
} from '../../utils/errors.js';
import { env } from '../../config/env.js';
import type {
  JwtAccessPayload,
  JwtRefreshPayload,
  AuthTokens,
  RiskLevel,
} from '@zk-auth/types';

// ─── Redis session cache payload ──────────────────────────────────────────────

interface SessionCacheEntry {
  userId: string;
  riskLevel: RiskLevel;
  stepUpRequired: boolean;
  createdAt: number;         // Unix epoch ms
}

// ─── JWT parse TTL helper ─────────────────────────────────────────────────────

function parseTtlToSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match || !match[1] || !match[2]) throw new Error(`Invalid TTL format: ${ttl}`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3_600;
    case 'd': return value * 86_400;
    default:  throw new Error(`Unknown TTL unit: ${unit}`);
  }
}

const ACCESS_TTL_S  = parseTtlToSeconds(env.JWT_ACCESS_EXPIRY);
const REFRESH_TTL_S = parseTtlToSeconds(env.JWT_REFRESH_EXPIRY);

// ─── Service ─────────────────────────────────────────────────────────────────

export class SessionService {

  // ─── Issue: create new session after successful ZKP verification ──────────

  /**
   * Issue a new session with fresh token pair.
   *
   * @param userId           - Authenticated user's UUID
   * @param deviceFingerprint - Optional device fingerprint for binding
   * @param ipAddress        - Optional client IP for audit
   */
  async issue(
    userId: string,
    deviceFingerprint?: string,
    ipAddress?: string,
  ): Promise<AuthTokens> {
    const sessionId = generateId();
    const refreshJti = generateId();    // unique ID for this refresh token
    const now = Math.floor(Date.now() / 1_000);   // Unix epoch seconds
    const expiresAt = new Date((now + REFRESH_TTL_S) * 1_000);

    // ── 1. Sign tokens ───────────────────────────────────────────────────────

    const accessPayload: Omit<JwtAccessPayload, 'iat' | 'exp'> = {
      sub: userId,
      sid: sessionId,
      risk: 'LOW',
      type: 'access',
    };

    const refreshPayload: Omit<JwtRefreshPayload, 'iat' | 'exp'> = {
      sub: userId,
      sid: sessionId,
      jti: refreshJti,
      type: 'refresh',
    };

    const accessToken = jwt.sign(accessPayload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRY,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    const refreshToken = jwt.sign(refreshPayload, env.JWT_REFRESH_SECRET, {
      expiresIn: env.JWT_REFRESH_EXPIRY,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    // ── 2. Hash refresh token for storage (never store raw) ──────────────────
    const refreshTokenHash = sha256(refreshToken);

    // ── 3. Persist session row to PostgreSQL ──────────────────────────────────
    try {
      await prisma.session.create({
        data: {
          id: sessionId,
          userId,
          refreshTokenHash,
          deviceFingerprint: deviceFingerprint ?? null,
          ipAddress: ipAddress ?? null,
          riskLevel: 'LOW',
          isRevoked: false,
          expiresAt,
          lastActiveAt: new Date(),
        },
      });
    } catch (err) {
      logger.error({ err, userId, sessionId }, 'Failed to create session in PostgreSQL');
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Session creation failed', 500);
    }

    // ── 4. Initialise session risk state in Redis ─────────────────────────────
    // Redis session cache is the read path for every authenticated request —
    // must be seeded immediately after PG write.
    const cacheEntry: SessionCacheEntry = {
      userId,
      riskLevel: 'LOW',
      stepUpRequired: false,
      createdAt: Date.now(),
    };

    await redis
      .set(
        RedisKeys.session(sessionId),
        JSON.stringify(cacheEntry),
        'EX', REFRESH_TTL_S,  // cache TTL matches refresh token TTL
      )
      .catch((err) =>
        logger.warn({ err, sessionId }, 'Failed to seed session risk cache in Redis'),
      );

    // ── 5. Update user last_login_at ──────────────────────────────────────────
    await prisma.user
      .update({
        where: { id: userId },
        data: { lastLoginAt: new Date() },
      })
      .catch((err) =>
        logger.warn({ err, userId }, 'Failed to update last_login_at — non-critical'),
      );

    logger.info({ userId, sessionId }, 'Session issued');

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      session_id: sessionId,
    };
  }

  // ─── Rotate: secure refresh token rotation ───────────────────────────────

  /**
   * Validate an incoming refresh token, revoke its session, and issue
   * a completely fresh token pair in a new session row.
   *
   * This is "refresh token rotation" — each refresh token is one-time use.
   * A stolen refresh token used by an attacker invalidates the legitimate
   * user's current session, triggering re-authentication.
   */
  async rotate(
    rawRefreshToken: string,
    deviceFingerprint?: string,
    ipAddress?: string,
  ): Promise<AuthTokens> {
    // ── 1. Verify refresh token signature and expiry ──────────────────────────
    let decoded: JwtRefreshPayload;
    try {
      decoded = jwt.verify(rawRefreshToken, env.JWT_REFRESH_SECRET, {
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      }) as JwtRefreshPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppError(ErrorCode.TOKEN_EXPIRED, 'Refresh token has expired', 401);
      }
      throw new UnauthorizedError('Invalid refresh token');
    }

    if (decoded.type !== 'refresh') {
      throw new UnauthorizedError('Token type mismatch');
    }

    // ── 2. Look up session by ID ──────────────────────────────────────────────
    const session = await prisma.session.findUnique({
      where: { id: decoded.sid },
      select: {
        id: true,
        userId: true,
        refreshTokenHash: true,
        isRevoked: true,
        expiresAt: true,
        deviceFingerprint: true,
      },
    });

    if (!session) {
      throw new AppError(ErrorCode.TOKEN_REVOKED, 'Session not found', 401);
    }

    // ── 3. Check revocation (catches token reuse after rotation) ──────────────
    if (session.isRevoked) {
      // Reuse of a revoked refresh token — possible token theft.
      // Revoke ALL sessions for this user as a security response.
      logger.warn(
        { userId: session.userId, sessionId: session.id },
        'SECURITY: Revoked refresh token reuse detected — revoking all user sessions',
      );
      await this._revokeAllForUser(session.userId);
      throw new AppError(ErrorCode.TOKEN_REVOKED, 'Session revoked — please re-authenticate', 401);
    }

    // ── 4. Verify the token hash matches the stored hash ──────────────────────
    const incomingHash = sha256(rawRefreshToken);
    if (incomingHash !== session.refreshTokenHash) {
      // Hash mismatch despite valid JWT signature — should not happen in normal
      // operation. Treat as a replay/substitution attack.
      logger.error(
        { sessionId: session.id },
        'Refresh token hash mismatch — token substitution attack suspected',
      );
      throw new UnauthorizedError('Invalid refresh token');
    }

    // ── 5. Revoke the old session atomically ──────────────────────────────────
    await prisma.session.update({
      where: { id: session.id },
      data: { isRevoked: true },
    });

    // Remove old session from Redis cache
    await redis.del(RedisKeys.session(session.id)).catch((err) =>
      logger.warn({ err, sessionId: session.id }, 'Failed to delete old session from Redis cache'),
    );

    // ── 6. Issue a fresh session ──────────────────────────────────────────────
    return this.issue(session.userId, deviceFingerprint, ipAddress);
  }

  // ─── Revoke: single session ───────────────────────────────────────────────

  async revokeSession(sessionId: string, userId: string): Promise<void> {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true, isRevoked: true },
    });

    if (!session || session.userId !== userId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Session not found', 404);
    }

    if (session.isRevoked) return;  // idempotent

    await prisma.session.update({
      where: { id: sessionId },
      data: { isRevoked: true },
    });

    await redis.del(RedisKeys.session(sessionId)).catch((err) =>
      logger.warn({ err, sessionId }, 'Failed to remove revoked session from Redis'),
    );

    logger.info({ sessionId, userId }, 'Session revoked');
  }

  // ─── Revoke all: logout from all devices ────────────────────────────────

  async revokeAllForUser(userId: string): Promise<number> {
    return this._revokeAllForUser(userId);
  }

  // ─── Verify access token (used by auth middleware) ───────────────────────

  /**
   * Verify and decode an access token.
   * Also validates the session is not revoked in Redis (fast-path)
   * or PostgreSQL (fallback if Redis cache miss).
   */
  async verifyAccessToken(rawToken: string): Promise<JwtAccessPayload> {
    // Step 1: Verify JWT signature and expiry
    let decoded: JwtAccessPayload;
    try {
      decoded = jwt.verify(rawToken, env.JWT_ACCESS_SECRET, {
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      }) as JwtAccessPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppError(ErrorCode.TOKEN_EXPIRED, 'Access token has expired', 401);
      }
      throw new UnauthorizedError('Invalid access token');
    }

    if (decoded.type !== 'access') {
      throw new UnauthorizedError('Token type mismatch');
    }

    // Step 2: Check Redis session cache (fast path — avoids DB on every request)
    const cached = await redis.get(RedisKeys.session(decoded.sid));
    if (cached !== null) {
      const entry = JSON.parse(cached) as SessionCacheEntry;
      if (entry.riskLevel) {
        // Attach live risk level from cache to the decoded payload
        decoded.risk = entry.riskLevel;
      }
      return decoded;
    }

    // Step 3: Redis cache miss — fall back to PostgreSQL
    const session = await prisma.session.findUnique({
      where: { id: decoded.sid },
      select: { isRevoked: true, riskLevel: true, expiresAt: true },
    });

    if (!session || session.isRevoked) {
      throw new AppError(ErrorCode.TOKEN_REVOKED, 'Session has been revoked', 401);
    }

    if (session.expiresAt < new Date()) {
      throw new AppError(ErrorCode.TOKEN_EXPIRED, 'Session has expired', 401);
    }

    // Re-seed Redis cache from PG (warm the cache)
    const reseedEntry: SessionCacheEntry = {
      userId: decoded.sub,
      riskLevel: session.riskLevel as RiskLevel,
      stepUpRequired: false,
      createdAt: Date.now(),
    };
    await redis
      .set(RedisKeys.session(decoded.sid), JSON.stringify(reseedEntry), 'EX', ACCESS_TTL_S)
      .catch(() => {/* non-critical */});

    decoded.risk = session.riskLevel as RiskLevel;
    return decoded;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _revokeAllForUser(userId: string): Promise<number> {
    // Get all active sessions for the user
    const sessions = await prisma.session.findMany({
      where: { userId, isRevoked: false },
      select: { id: true },
    });

    if (sessions.length === 0) return 0;

    const sessionIds = sessions.map((s) => s.id);

    // Bulk revoke in PG
    const result = await prisma.session.updateMany({
      where: { id: { in: sessionIds } },
      data: { isRevoked: true },
    });

    // Remove all from Redis cache (pipeline for efficiency)
    if (sessionIds.length > 0) {
      const pipeline = redis.pipeline();
      sessionIds.forEach((id) => pipeline.del(RedisKeys.session(id)));
      await pipeline.exec().catch((err) =>
        logger.warn({ err, userId }, 'Partial Redis session cache clear failure'),
      );
    }

    logger.info({ userId, count: result.count }, 'All user sessions revoked');
    return result.count;
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const sessionService = new SessionService();
