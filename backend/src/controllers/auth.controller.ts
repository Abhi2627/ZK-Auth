/**
 * Auth Controller — ZKP Authentication Flow
 *
 * Implements the four endpoints of the Pillar 1 authentication flow:
 *
 *   POST /auth/challenge  — Issue a nonce challenge
 *   POST /auth/verify     — Verify Groth16 proof, issue JWTs
 *   POST /auth/refresh    — Rotate refresh token, issue new pair
 *   POST /auth/logout     — Revoke session(s)
 *
 * ─── Verify flow (critical path, detailed) ───────────────────────────────────
 *
 *   1. [Zod] Parse and validate request body.
 *   2. [ChallengeService] Fetch challenge from Redis — validates TTL.
 *   3. [NullifierService] Fast pre-check — is nullifier already in Redis SET?
 *      If yes → immediate 400 NULLIFIER_REPLAY (avoids expensive ZKP verify).
 *   4. [ZkpService] Run SnarkJS Groth16 verification with constant-time padding.
 *      - Validates proof structure.
 *      - Verifies proof against in-memory vKey.
 *      - Looks up user by commitment_root.
 *   5. [ChallengeService] Atomically consume challenge (Redis DEL + PG update).
 *      If DEL returns 0 → another request consumed it concurrently → 400 REPLAY.
 *   6. [NullifierService] Two-phase register nullifier (Redis SADD + PG INSERT).
 *      If SADD returns 0 → race condition caught → 400 REPLAY.
 *   7. [SessionService] Issue JWTs and seed Redis session cache.
 *   8. Return tokens.
 *
 * The ordering of steps 5 and 6 is intentional:
 *   - Challenge is consumed AFTER proof verification (don't burn a challenge on
 *     an invalid proof — the nonce is still valid for a retry within TTL).
 *     Wait — actually we consume BEFORE registering the nullifier, because if
 *     nullifier registration fails we roll back Redis SADD. The challenge should
 *     be consumed regardless (prevent reuse with a different proof for same nonce).
 *   - If nullifier registration fails after challenge consumption, the user must
 *     request a new challenge. This is the correct security posture.
 */

import type { Request, Response, NextFunction } from 'express';
import { challengeService } from '../services/zkp/challenge.service.js';
import { nullifierService } from '../services/zkp/nullifier.service.js';
import { zkpService } from '../services/zkp/zkp.service.js';
import { sessionService } from '../services/session/session.service.js';
import {
  parseBody,
  challengeRequestSchema,
  verifyRequestSchema,
  refreshRequestSchema,
  logoutRequestSchema,
} from './auth.schemas.js';
import { logger } from '../utils/logger.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { AuthenticatedSession } from '../middleware/auth.middleware.js';

// ─── POST /auth/challenge ─────────────────────────────────────────────────────

export async function postChallenge(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseBody(challengeRequestSchema, req.body);

    // If a commitment_hash is provided, we can look up the userId to bind
    // the challenge. If not, issue an anonymous challenge.
    let userId: string | null = null;

    if (body.commitment_hash) {
      const { prisma } = await import('../config/database.js');
      const user = await prisma.user.findUnique({
        where: { commitmentHash: body.commitment_hash },
        select: { id: true, status: true },
      });
      // Silently continue with userId=null if user not found — do NOT reveal
      // whether the commitment is registered (prevents enumeration).
      if (user?.status === 'ACTIVE') {
        userId = user.id;
      }
    }

    const challenge = await challengeService.issue(userId);

    res.status(200).json({
      challenge_id: challenge.challengeId,
      nonce: challenge.nonce,
      expires_at: challenge.expiresAt,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/verify ────────────────────────────────────────────────────────

export async function postVerify(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Step 1: Validate request body
    const body = parseBody(verifyRequestSchema, req.body);
    const { challenge_id, proof, public_signals } = body;
    const [nullifierHash] = public_signals;

    // Step 2: Fetch challenge (validates TTL, throws CHALLENGE_EXPIRED if stale)
    const challengePayload = await challengeService.fetch(challenge_id);

    // Step 3: Fast pre-check — nullifier already spent?
    const alreadySpent = await nullifierService.exists(nullifierHash);
    if (alreadySpent) {
      logger.warn({ nullifierHash, challenge_id }, 'Fast-path nullifier replay rejection');
      throw new AppError(ErrorCode.NULLIFIER_REPLAY, 'Proof replay detected', 400);
    }

    // Step 4: ZKP verification (includes constant-time padding)
    const verifyResult = await zkpService.verify({
      proof,
      publicSignals: public_signals,
      challengeNonce: challengePayload.nonce,
    });

    // Step 5: Consume challenge (Redis DEL + PG CONSUMED)
    // After this point, the nonce can never be used again.
    await challengeService.consume(challenge_id);

    // Step 6: Register nullifier (two-phase atomic — T4 mitigation)
    await nullifierService.register({
      nullifierHash: verifyResult.nullifierHash,
      userId: verifyResult.userId,
      challengeId: challenge_id,
    });

    // Step 7: Issue session tokens
    const deviceFingerprint = req.headers['x-device-fingerprint'] as string | undefined;
    const ipAddress = getClientIp(req);

    const tokens = await sessionService.issue(
      verifyResult.userId,
      deviceFingerprint,
      ipAddress,
    );

    // Step 8: Set refresh token as HttpOnly cookie (web clients)
    // Mobile clients read from the response body.
    setRefreshCookie(res, tokens.refresh_token);

    logger.info(
      { userId: verifyResult.userId, sessionId: tokens.session_id },
      'Authentication successful',
    );

    res.status(200).json({
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      session_id: tokens.session_id,
      // refresh_token also in body for mobile clients
      refresh_token: tokens.refresh_token,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

export async function postRefresh(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseBody(refreshRequestSchema, req.body);

    // Web clients send via HttpOnly cookie; mobile clients send in body.
    const rawRefreshToken =
      body.refresh_token ??
      (req.cookies as Record<string, string | undefined>)['zkauth_refresh'];

    if (!rawRefreshToken) {
      throw new AppError(
        ErrorCode.INVALID_TOKEN,
        'Refresh token is required (cookie or body)',
        400,
      );
    }

    const deviceFingerprint = req.headers['x-device-fingerprint'] as string | undefined;
    const ipAddress = getClientIp(req);

    const tokens = await sessionService.rotate(
      rawRefreshToken,
      deviceFingerprint,
      ipAddress,
    );

    // Rotate the cookie as well
    setRefreshCookie(res, tokens.refresh_token);

    res.status(200).json({
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      session_id: tokens.session_id,
      refresh_token: tokens.refresh_token,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/logout ────────────────────────────────────────────────────────

export async function postLogout(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;
    const body = parseBody(logoutRequestSchema, req.body);

    if (body.all_devices) {
      const count = await sessionService.revokeAllForUser(session.userId);
      logger.info({ userId: session.userId, count }, 'All sessions revoked (logout all)');
    } else {
      await sessionService.revokeSession(session.sessionId, session.userId);
      logger.info({ sessionId: session.sessionId }, 'Session revoked (logout)');
    }

    // Clear the refresh cookie
    clearRefreshCookie(res);

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setRefreshCookie(res: Response, token: string): void {
  res.cookie('zkauth_refresh', token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1_000,  // 7 days in ms
    path: '/api/v1/auth/refresh',        // scoped to refresh endpoint only
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie('zkauth_refresh', {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth/refresh',
  });
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim() ?? req.socket?.remoteAddress ?? 'unknown';
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
