/**
 * Session Controller — Step-Up Auth Resolution + Device Management
 *
 * POST /session/step-up/challenge  — issue a fresh ZKP challenge for re-auth
 * POST /session/step-up/resolve    — verify proof, reset risk, unlock session
 * GET  /session/me                 — current session state + step-up flag
 * GET  /session/devices            — list all active sessions with device info
 * POST /session/revoke/:sessionId  — two-phase revoke: Redis DEL + PG is_revoked
 * DELETE /session/:sessionId       — alias for POST /session/revoke/:sessionId
 * DELETE /session/all              — revoke all sessions for authenticated user
 *
 * ─── Device listing security ──────────────────────────────────────────────────
 *   GET /session/devices returns sessions for the AUTHENTICATED user only.
 *   Ownership is validated via the JWT sub claim (userId in res.locals.session).
 *   No session data from other users is ever returned.
 *
 * ─── Two-phase revoke (T11 mitigation) ────────────────────────────────────────
 *   Phase 1: Redis DEL session:{id} — immediately invalidates the cache
 *            so the next authenticated request to the gateway cannot
 *            read a valid risk level and will fall through to PG verification.
 *   Phase 2: PG UPDATE sessions SET is_revoked = true — durable record.
 *            The auth middleware's PG fallback path will see is_revoked=true
 *            and return 401 TOKEN_REVOKED for any in-flight access tokens.
 *
 *   Ordering matters: Redis first, PG second. If PG fails after Redis DEL,
 *   the session is effectively dead (no cache entry) but the PG record
 *   is inconsistent. A background cleanup job (Phase 9) reconciles these.
 *   If Redis fails and PG succeeds, the session cache is stale but PG
 *   revocation still blocks the session on the next PG fallback check.
 */

import type { Request, Response, NextFunction } from 'express';
import { challengeService }  from '../services/zkp/challenge.service.js';
import { nullifierService }  from '../services/zkp/nullifier.service.js';
import { zkpService }        from '../services/zkp/zkp.service.js';
import { sessionService }    from '../services/session/session.service.js';
import { riskService }       from '../services/session/risk.service.js';
import { pushToSession }     from '../websocket/wsServer.js';
import { parseBody }         from './auth.schemas.js';
import { verifyRequestSchema } from './auth.schemas.js';
import { logger }            from '../utils/logger.js';
import { AppError, ErrorCode, NotFoundError } from '../utils/errors.js';
import type { AuthenticatedSession } from '../middleware/auth.middleware.js';
import { prisma }            from '../config/database.js';
import { redis, RedisKeys }  from '../config/redis.js';

// ─── POST /session/step-up/challenge ─────────────────────────────────────────

export async function postStepUpChallenge(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;

    const pending = await redis.get(RedisKeys.stepUp(session.sessionId));
    if (!pending) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'No step-up authentication pending for this session',
        403,
      );
    }

    const challenge = await challengeService.issue(session.userId);

    res.status(200).json({
      challenge_id: challenge.challengeId,
      nonce:        challenge.nonce,
      expires_at:   challenge.expiresAt,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /session/step-up/resolve ───────────────────────────────────────────

export async function postStepUpResolve(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;
    const body    = parseBody(verifyRequestSchema, req.body);
    const { challenge_id, proof, public_signals } = body;
    const [nullifierHash] = public_signals;

    const pending = await redis.get(RedisKeys.stepUp(session.sessionId));
    if (!pending) {
      throw new AppError(ErrorCode.FORBIDDEN, 'No step-up pending for this session', 403);
    }

    const challengePayload = await challengeService.fetch(challenge_id);

    const alreadySpent = await nullifierService.exists(nullifierHash);
    if (alreadySpent) {
      throw new AppError(ErrorCode.NULLIFIER_REPLAY, 'Proof replay detected', 400);
    }

    const verifyResult = await zkpService.verify({
      proof,
      publicSignals:  public_signals,
      challengeNonce: challengePayload.nonce,
    });

    if (verifyResult.userId !== session.userId) {
      logger.error(
        { sessionUserId: session.userId, proofUserId: verifyResult.userId },
        'Step-up resolve: proof user mismatch',
      );
      throw new AppError(ErrorCode.INVALID_PROOF, 'Proof verification failed', 400);
    }

    await challengeService.consume(challenge_id);

    await nullifierService.register({
      nullifierHash:  verifyResult.nullifierHash,
      userId:         verifyResult.userId,
      challengeId:    challenge_id,
    });

    await riskService.resolveStepUp(session.sessionId, session.userId);

    pushToSession(session.sessionId, {
      type:    'STEP_UP_RESOLVED',
      payload: { session_id: session.sessionId },
      ts:      Date.now(),
    });

    logger.info({ sessionId: session.sessionId, userId: session.userId }, 'Step-up resolved');

    res.status(200).json({ resolved: true });
  } catch (err) {
    next(err);
  }
}

// ─── GET /session/me ──────────────────────────────────────────────────────────

export async function getSessionMe(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;

    const dbSession = await prisma.session.findUnique({
      where:  { id: session.sessionId },
      select: {
        id:                true,
        riskLevel:         true,
        createdAt:         true,
        lastActiveAt:      true,
        deviceFingerprint: true,
        deviceLabel:       true,
        ipAddress:         true,
      },
    });

    if (!dbSession) throw new NotFoundError('Session');

    const stepUpRaw = await redis.get(RedisKeys.stepUp(session.sessionId));
    const stepUp    = stepUpRaw
      ? (JSON.parse(stepUpRaw) as { requiredLevel: string; issuedAt: number })
      : null;

    res.status(200).json({
      session_id:         session.sessionId,
      user_id:            session.userId,
      risk_level:         session.riskLevel,
      step_up_required:   stepUp !== null,
      step_up_level:      stepUp?.requiredLevel ?? null,
      created_at:         dbSession.createdAt.toISOString(),
      last_active_at:     dbSession.lastActiveAt.toISOString(),
      device_fingerprint: dbSession.deviceFingerprint,
      device_label:       dbSession.deviceLabel,
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /session/devices ─────────────────────────────────────────────────────

export async function getDevices(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;

    // Fetch all non-expired, non-revoked sessions for this user
    const sessions = await prisma.session.findMany({
      where: {
        userId:    session.userId,
        isRevoked: false,
        expiresAt: { gt: new Date() },  // exclude naturally expired sessions
      },
      select: {
        id:                true,
        deviceFingerprint: true,
        deviceLabel:       true,
        ipAddress:         true,
        riskLevel:         true,
        createdAt:         true,
        lastActiveAt:      true,
      },
      orderBy: { lastActiveAt: 'desc' },
    });

    // Check which sessions have a pending step-up via Redis pipeline
    const pipeline = redis.pipeline();
    sessions.forEach((s) => pipeline.get(RedisKeys.stepUp(s.id)));
    const stepUpResults = await pipeline.exec();

    const formattedSessions = sessions.map((s, i) => {
      const stepUpRaw = stepUpResults?.[i]?.[1];
      const hasStepUp = typeof stepUpRaw === 'string' && stepUpRaw !== null;

      return {
        id:                s.id,
        device_label:      s.deviceLabel,
        device_fingerprint: s.deviceFingerprint,
        ip_address:        s.ipAddress,
        risk_level:        s.riskLevel,
        created_at:        s.createdAt.toISOString(),
        last_active_at:    s.lastActiveAt.toISOString(),
        step_up_required:  hasStepUp,
        // Mark the current session so the UI can show "This device"
        is_current:        s.id === session.sessionId,
      };
    });

    res.status(200).json({
      sessions: formattedSessions,
      total:    formattedSessions.length,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /session/revoke/:sessionId ─────────────────────────────────────────

export async function postRevokeSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session   = res.locals['session'] as AuthenticatedSession;
    const { sessionId } = req.params as { sessionId: string };

    if (!sessionId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'sessionId path parameter is required', 400);
    }

    // ── Ownership check ─────────────────────────────────────────────────────
    // Fetch the target session and verify it belongs to the authenticated user.
    // This prevents one user from revoking another user's session even if they
    // know the session UUID.
    const target = await prisma.session.findUnique({
      where:  { id: sessionId },
      select: { userId: true, isRevoked: true },
    });

    if (!target) {
      throw new NotFoundError('Session');
    }

    if (target.userId !== session.userId) {
      // Return the same NotFoundError (don't reveal session exists for other user)
      throw new NotFoundError('Session');
    }

    if (target.isRevoked) {
      // Idempotent — already revoked, return success
      res.status(200).json({ message: 'Session already revoked', session_id: sessionId });
      return;
    }

    // ── Two-phase revocation ────────────────────────────────────────────────

    // Phase 1: Redis DEL — invalidates live session cache immediately.
    // Any in-flight request using this session's access token will miss the cache
    // and fall through to PG, where it will find is_revoked=true.
    const redisDeleted = await redis.del(RedisKeys.session(sessionId));

    // Also clear any step-up pending state
    await redis.del(RedisKeys.stepUp(sessionId)).catch((err) =>
      logger.warn({ err, sessionId }, 'Failed to clear step-up key during revocation'),
    );

    // Phase 2: PG UPDATE — durable revocation record.
    await prisma.session.update({
      where: { id: sessionId },
      data:  { isRevoked: true },
    });

    // Close the WebSocket connection for this session if it's active
    pushToSession(sessionId, {
      type:    'SESSION_TERMINATED',
      payload: {},
      ts:      Date.now(),
    });

    logger.info(
      { revokedSessionId: sessionId, byUserId: session.userId, redisDeleted },
      'Session revoked via device management',
    );

    res.status(200).json({
      message:    'Session revoked',
      session_id: sessionId,
    });
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /session/:sessionId (alias) ───────────────────────────────────────

export async function deleteSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return postRevokeSession(req, res, next);
}

// ─── DELETE /session/all ──────────────────────────────────────────────────────

export async function deleteAllSessions(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;
    const count   = await sessionService.revokeAllForUser(session.userId);
    res.status(200).json({ message: `${count} sessions revoked` });
  } catch (err) {
    next(err);
  }
}
