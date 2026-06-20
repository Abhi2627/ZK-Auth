/**
 * OAuth Routes — /oauth
 *
 *   GET  /oauth/authorize  — validate client/redirect/scope, return context
 *                            for the frontend to render the ZKP login widget
 *   POST /oauth/token      — exchange a ZKP-authorized code for a session
 *
 * Rate limits follow the same philosophy as auth.routes.ts: /token is the
 * sensitive, code-redeeming endpoint and gets a tighter limit than /authorize,
 * which only validates request shape and touches no secret material.
 */

import { Router } from 'express';
import { getAuthorize, postToken } from '../controllers/oauth.controller.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.middleware.js';

export const oauthRouter = Router();

const authorizeRateLimit = rateLimitMiddleware({
  endpoint: 'oauth_authorize',
  limit: 30,
  windowSeconds: 60,
});

const tokenRateLimit = rateLimitMiddleware({
  endpoint: 'oauth_token',
  limit: 20,
  windowSeconds: 60,
});

oauthRouter.get('/authorize', authorizeRateLimit, getAuthorize);
oauthRouter.post('/token', tokenRateLimit, postToken);
