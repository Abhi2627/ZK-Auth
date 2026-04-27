/**
 * Credential Routes — /api/v1/credential
 *
 * Route → Middleware chain → Controller mapping:
 *
 *   POST /issue         authMiddleware → requireIssuerRole → postIssueCredential
 *   POST /verify-claim  (public — no auth required) → postVerifyClaim
 *   POST /revoke        authMiddleware → requireIssuerRole → postRevokeCredential
 *   GET  /:credentialId authMiddleware → getCredential
 *
 * /verify-claim is intentionally unauthenticated:
 *   Third-party verifiers submit proofs and receive a boolean result.
 *   They do not need — and must not have — access to user sessions or tokens.
 *   Rate limiting is applied to prevent proof-stuffing attacks.
 */

import { Router } from 'express';
import {
  postIssueCredential,
  postVerifyClaim,
  postRevokeCredential,
  getCredential,
} from '../controllers/credential.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireIssuerRole } from '../middleware/issuerRole.middleware.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.middleware.js';

export const credentialRouter = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────

const issueRateLimit = rateLimitMiddleware({
  endpoint: 'credential_issue',
  limit: 20,
  windowSeconds: 60,
});

const verifyClaimRateLimit = rateLimitMiddleware({
  endpoint: 'credential_verify',
  limit: 60,
  windowSeconds: 60,
});

const revokeRateLimit = rateLimitMiddleware({
  endpoint: 'credential_revoke',
  limit: 10,
  windowSeconds: 60,
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/v1/credential/issue  (Issuer only)
credentialRouter.post(
  '/issue',
  issueRateLimit,
  authMiddleware,
  requireIssuerRole,
  postIssueCredential,
);

// POST /api/v1/credential/verify-claim  (Public — verifier endpoint)
credentialRouter.post(
  '/verify-claim',
  verifyClaimRateLimit,
  postVerifyClaim,
);

// POST /api/v1/credential/revoke  (Issuer only)
credentialRouter.post(
  '/revoke',
  revokeRateLimit,
  authMiddleware,
  requireIssuerRole,
  postRevokeCredential,
);

// GET /api/v1/credential/:credentialId  (Owner only)
credentialRouter.get(
  '/:credentialId',
  authMiddleware,
  getCredential,
);
