/**
 * Session Controller — Step-Up Auth Resolution
 *
 * POST /session/step-up/challenge  — issue a fresh ZKP challenge for re-auth
 * POST /session/step-up/resolve    — verify proof, reset risk, clear step-up flag
 * GET  /session/me                 — current session state
 * DELETE /session/:sessionId       — revoke session
 * DELETE /session/all              — revoke all sessions
 *
 * ─── Step-Up Resolve flow ─────────────────────────────────────────────────────
 *   1. [authMiddleware]    Verify access token → session context.
 *   2. [Zod]              Validate proof payload.
 *   3. [ChallengeService] Fetch and validate the step-up challenge nonce.
 *   4. [NullifierService] Fast pre-check for replay.
 *   5. [ZkpService]       Verify Groth16 proof with constant-time padding.
 *   6. [ChallengeService] Consume challenge (Redis DEL).
 *   7. [NullifierService] Two-phase register nullifier.
 *   8. [RiskService]      resolveStepUp() — clear Redis step-up key,
 *                         reset riskLevel to LOW in session cache.
 *   9. [WsServer]         pushToSession() — emit STEP_UP_RESOLVED over WebSocket.
 *  10. Return { resolved: true }.
 *
 * Crucially: step-up resolve does NOT issue a new JWT. The existing access
 * token remains valid — only the risk state in Redis is reset. This is the
 * correct model: the user's identity was already verified at login; we are
 * re-verifying liveness, not re-issuing credentials.
 */

import type { Request, Response, NextFunction } from 'express';
import { challengeService } from '../services/zkp/challenge.service.js';
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

    // Verify that a step-up is actually pending for this session
    const pending = await redis.get(RedisKeys.stepUp(session.sessionId));
    if (!pending) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'No step-up authentication pending for this session',
        403,
      );
    }

    // Issue a challenge bound to this user
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

    // Step 1: Validate request body (same shape as /auth/verify)
    const body = parseBody(verifyRequestSchema, req.body);
    const { challenge_id, proof, public_signals } = body;
    const [nullifierHash] = public_signals;

    // Step 2: Confirm step-up is pending (prevent resolve without prior trigger)
    const pending = await redis.get(RedisKeys.stepUp(session.sessionId));
    if (!pending) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'No step-up pending for this session',
        403,
      );
    }

    // Step 3: Fetch challenge
    const challengePayload = await challengeService.fetch(challenge_id);

    // Step 4: Fast nullifier pre-check
    const alreadySpent = await nullifierService.exists(nullifierHash);
    if (alreadySpent) {
      throw new AppError(ErrorCode.NULLIFIER_REPLAY, 'Proof replay detected', 400);
    }

    // Step 5: ZKP verification (constant-time padded)
    const verifyResult = await zkpService.verify({
      proof,
      publicSignals: public_signals,
      challengeNonce: challengePayload.nonce,
    });

    // Assert: the proof belongs to the SAME user as the current session
    // This prevents a different user's valid proof from resolving someone else's step-up
    if (verifyResult.userId !== session.userId) {
      logger.error(
        { sessionUserId: session.userId, proofUserId: verifyResult.userId },
        'Step-up resolve: proof user mismatch — possible session confusion attack',
      );
      throw new AppError(ErrorCode.INVALID_PROOF, 'Proof verification failed', 400);
    }

    // Step 6: Consume challenge
    await challengeService.consume(challenge_id);

    // Step 7: Register nullifier
    await nullifierService.register({
      nullifierHash:  verifyResult.nullifierHash,
      userId:         verifyResult.userId,
      challengeId:    challenge_id,
    });

    // Step 8: Reset risk state in Redis
    await riskService.resolveStepUp(session.sessionId, session.userId);

    // Step 9: Emit STEP_UP_RESOLVED over WebSocket to unlock client UI
    const pushed = pushToSession(session.sessionId, {
      type: 'SESSION_TERMINATED',  // reuse existing WS type — client handles gracefully
    });
    // Use a dedicated resolved event type:
    pushToSession(session.sessionId, {
      type:    'STEP_UP_RESOLVED',
      payload: { session_id: session.sessionId },
      ts:      Date.now(),
    });

    logger.info(
      { sessionId: session.sessionId, userId: session.userId, wsPushed: pushed },
      'Step-up resolved successfully',
    );

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
      where: { id: session.sessionId },
      select: {
        id:               true,
        riskLevel:        true,
        createdAt:        true,
        lastActiveAt:     true,
        deviceFingerprint: true,
        ipAddress:        true,
      },
    });

    if (!dbSession) throw new NotFoundError('Session');

    // Check if step-up is pending
    const stepUpRaw = await redis.get(RedisKeys.stepUp(session.sessionId));
    const stepUp = stepUpRaw ? JSON.parse(stepUpRaw) as { requiredLevel: string; issuedAt: number } : null;

    res.status(200).json({
      session_id:         session.sessionId,
      user_id:            session.userId,
      risk_level:         session.riskLevel,
      step_up_required:   stepUp !== null,
      step_up_level:      stepUp?.requiredLevel ?? null,
      created_at:         dbSession.createdAt.toISOString(),
      last_active_at:     dbSession.lastActiveAt.toISOString(),
      device_fingerprint: dbSession.deviceFingerprint,
    });
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /session/:sessionId ───────────────────────────────────────────────

export async function deleteSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session    = res.locals['session'] as AuthenticatedSession;
    const { sessionId } = req.params as { sessionId: string };

    if (!sessionId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'sessionId required', 400);
    }

    await sessionService.revokeSession(sessionId, session.userId);
    res.status(200).json({ message: 'Session revoked' });
  } catch (err) {
    next(err);
  }
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
