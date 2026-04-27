/**
 * Session Routes — /api/v1/session
 *
 *   POST   /step-up/challenge  authMiddleware → postStepUpChallenge
 *   POST   /step-up/resolve    authMiddleware → postStepUpResolve
 *   GET    /me                 authMiddleware → riskGateMiddleware → getSessionMe
 *   DELETE /:sessionId         authMiddleware → deleteSession
 *   DELETE /all                authMiddleware → deleteAllSessions
 *
 * Note: WebSocket upgrade to /telemetry is handled in wsServer.ts,
 * not through this router (HTTP upgrade bypasses Express routing).
 */

import { Router } from 'express';
import {
  postStepUpChallenge,
  postStepUpResolve,
  getSessionMe,
  deleteSession,
  deleteAllSessions,
} from '../controllers/session.controller.js';
import { authMiddleware }    from '../middleware/auth.middleware.js';
import { riskGateMiddleware } from '../middleware/riskGate.middleware.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.middleware.js';

export const sessionRouter = Router();

const stepUpRateLimit = rateLimitMiddleware({
  endpoint: 'step_up',
  limit:    10,
  windowSeconds: 60,
});

// Step-up challenge & resolve
sessionRouter.post('/step-up/challenge', authMiddleware, stepUpRateLimit, postStepUpChallenge);
sessionRouter.post('/step-up/resolve',   authMiddleware, stepUpRateLimit, postStepUpResolve);

// Session introspection
sessionRouter.get('/me', authMiddleware, riskGateMiddleware, getSessionMe);

// Session revocation
sessionRouter.delete('/all',         authMiddleware, deleteAllSessions);
sessionRouter.delete('/:sessionId',  authMiddleware, deleteSession);
