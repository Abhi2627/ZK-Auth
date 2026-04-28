/**
 * Auth Routes — /api/v1/auth
 *
 * Route → Middleware chain → Controller:
 *
 *   POST /register   registerRateLimit → postRegister
 *   POST /challenge  challengeRateLimit → postChallenge
 *   POST /verify     authVerifyRateLimit → postVerify
 *   POST /refresh    refreshRateLimit → postRefresh
 *   POST /logout     authMiddleware → postLogout
 *   POST /recover    recoverRateLimit → postRecover
 *
 * Rate limits:
 *   /register — 5/hour per IP (expensive Argon2 generation)
 *   /challenge — 10/min per IP
 *   /verify    — 20/min per IP
 *   /refresh   — 30/min per IP
 *   /recover   — 3/hour per IP (intentionally very tight — Argon2 + global logout)
 */

import { Router } from 'express';
import {
  postRegister,
  postChallenge,
  postVerify,
  postRefresh,
  postLogout,
  postRecover,
} from '../controllers/auth.controller.js';
import {
  challengeRateLimit,
  authVerifyRateLimit,
  refreshRateLimit,
  rateLimitMiddleware,
} from '../middleware/rateLimit.middleware.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

export const authRouter = Router();

// ─── Per-endpoint rate limiters ───────────────────────────────────────────────

/** Registration: 5 per hour per IP — Argon2id is expensive by design */
const registerRateLimit = rateLimitMiddleware({
  endpoint:      'register',
  limit:         5,
  windowSeconds: 3_600,
});

/**
 * Recovery: 3 per hour per IP
 * Extremely tight because:
 *   1. Argon2id verification takes ~300ms server-side (intentional)
 *   2. Incorrect attempts burn the rate limit fast without revealing timing
 *   3. A legitimate user only needs to recover once
 */
const recoverRateLimit = rateLimitMiddleware({
  endpoint:      'recover',
  limit:         3,
  windowSeconds: 3_600,
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/v1/auth/register
authRouter.post('/register',  registerRateLimit,   postRegister);

// POST /api/v1/auth/challenge
authRouter.post('/challenge', challengeRateLimit,  postChallenge);

// POST /api/v1/auth/verify
authRouter.post('/verify',    authVerifyRateLimit, postVerify);

// POST /api/v1/auth/refresh
authRouter.post('/refresh',   refreshRateLimit,    postRefresh);

// POST /api/v1/auth/logout  (requires valid access token)
authRouter.post('/logout',    authMiddleware,      postLogout);

// POST /api/v1/auth/recover  (no auth required — this IS the auth fallback)
authRouter.post('/recover',   recoverRateLimit,    postRecover);
