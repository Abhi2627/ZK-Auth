/**
 * Auth Routes — /api/v1/auth
 *
 * Route → Middleware chain → Controller mapping:
 *
 *   POST /challenge    challengeRateLimit → postChallenge
 *   POST /verify       authVerifyRateLimit → postVerify
 *   POST /refresh      refreshRateLimit → postRefresh
 *   POST /logout       authMiddleware → riskGateMiddleware → postLogout
 *
 * Rate limiters run BEFORE controllers to reject flood attacks without
 * touching business logic or the database.
 *
 * Logout requires a valid access token (authMiddleware) so we know which
 * session to revoke. The refresh endpoint does NOT require a valid access
 * token — that's the entire point of a refresh flow.
 */

import { Router } from 'express';
import {
  postChallenge,
  postVerify,
  postRefresh,
  postLogout,
} from '../controllers/auth.controller.js';
import {
  challengeRateLimit,
  authVerifyRateLimit,
  refreshRateLimit,
} from '../middleware/rateLimit.middleware.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

export const authRouter = Router();

// POST /api/v1/auth/challenge
authRouter.post(
  '/challenge',
  challengeRateLimit,
  postChallenge,
);

// POST /api/v1/auth/verify
authRouter.post(
  '/verify',
  authVerifyRateLimit,
  postVerify,
);

// POST /api/v1/auth/refresh
authRouter.post(
  '/refresh',
  refreshRateLimit,
  postRefresh,
);

// POST /api/v1/auth/logout  (requires valid access token)
authRouter.post(
  '/logout',
  authMiddleware,
  postLogout,
);
