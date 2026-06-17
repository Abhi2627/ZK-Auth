/**
 * Session Routes — /api/v1/session
 *
 *   POST   /step-up/challenge  authMiddleware → postStepUpChallenge
 *   POST   /step-up/resolve    authMiddleware → postStepUpResolve
 *   GET    /me                 authMiddleware → riskGateMiddleware → getSessionMe
 *   GET    /devices            authMiddleware → getDevices
 *   POST   /revoke/:sessionId  authMiddleware → postRevokeSession
 *   DELETE /:sessionId         authMiddleware → deleteSession   (alias)
 *   DELETE /all                authMiddleware → deleteAllSessions
 *
 * Route ordering note:
 *   Express matches routes top-to-bottom. The literal /all route must be
 *   registered BEFORE /:sessionId to prevent "all" being treated as a UUID param.
 */

import { Router } from 'express';
import {
  postStepUpChallenge,
  postStepUpResolve,
  getSessionMe,
  getDevices,
  postRevokeSession,
  deleteSession,
  deleteAllSessions,
} from '../controllers/session.controller.js';
import { authMiddleware }     from '../middleware/auth.middleware.js';
import { riskGateMiddleware } from '../middleware/riskGate.middleware.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.middleware.js';

export const sessionRouter = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────

const stepUpRateLimit = rateLimitMiddleware({
  endpoint:      'step_up',
  limit:         10,
  windowSeconds: 60,
});

const revokeRateLimit = rateLimitMiddleware({
  endpoint:      'session_revoke',
  limit:         20,
  windowSeconds: 60,
});

// ─── DEV ONLY: manually trigger step-up to demo behavioral auth ──────────────
if (process.env['NODE_ENV'] !== 'production') {
  sessionRouter.post('/dev/trigger-stepup', authMiddleware, async (req, res, next) => {
    try {
      const session = res.locals['session'] as { sessionId: string; userId: string };
      const level   = (req.body as { level?: string })?.level ?? 'SOFT';
      const { pushToSession } = await import('../websocket/wsServer.js');
      const { redis, RedisKeys } = await import('../config/redis.js');

      const expiresAt = Date.now() + 300_000; // 5 minutes

      // Set step-up pending in Redis
      await redis.set(
        RedisKeys.stepUp(session.sessionId),
        JSON.stringify({ requiredLevel: level, issuedAt: Date.now() }),
        'EX', 300,
      );

      // Push WebSocket event to the client
      const sent = pushToSession(session.sessionId, {
        type: 'STEP_UP_REQUIRED',
        payload: {
          event:          'STEP_UP_REQUIRED',
          session_id:     session.sessionId,
          risk_score:     0.91,
          required_level: level,
          expires_at:     expiresAt,
        },
        ts: Date.now(),
      });

      res.json({
        triggered:  true,
        level,
        session_id: session.sessionId,
        ws_sent:    sent,
        message:    sent
          ? `Step-up fired. Check the browser — a ZKP re-auth modal should appear.`
          : `Step-up stored in Redis but no active WebSocket found for this session. Open the app first.`,
      });
    } catch (err) { next(err); }
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Step-up challenge & resolve
sessionRouter.post('/step-up/challenge', authMiddleware, stepUpRateLimit, postStepUpChallenge);
sessionRouter.post('/step-up/resolve',   authMiddleware, stepUpRateLimit, postStepUpResolve);

// Session introspection
sessionRouter.get('/me',      authMiddleware, riskGateMiddleware, getSessionMe);

// Device management — list all active sessions
sessionRouter.get('/devices', authMiddleware, getDevices);

// Two-phase revocation via POST (explicit action — preferred over DELETE for clarity)
sessionRouter.post('/revoke/:sessionId', authMiddleware, revokeRateLimit, postRevokeSession);

// DELETE aliases (REST convention compatibility)
sessionRouter.delete('/all',         authMiddleware, deleteAllSessions);   // MUST be before /:sessionId
sessionRouter.delete('/:sessionId',  authMiddleware, deleteSession);
