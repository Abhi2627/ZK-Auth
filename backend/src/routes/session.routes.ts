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
