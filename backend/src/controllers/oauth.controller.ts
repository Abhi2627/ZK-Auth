/**
 * OAuth Controller — /oauth/authorize and /oauth/token
 *
 * See oauth.service.ts for the full flow rationale. This controller is the
 * thin HTTP layer: parameter parsing/validation, delegating to OAuthService,
 * and shaping RFC 6749-compliant responses (including the redirect-with-code
 * step, which is the one part of the flow that is NOT just JSON in/out).
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { oauthService } from '../services/oauth/oauth.service.js';
import { ValidationError } from '../utils/errors.js';

// ─── GET /oauth/authorize ──────────────────────────────────────────────────
//
// This endpoint does NOT itself perform authentication. It validates the
// OAuth request parameters and returns them to the frontend, which then
// renders the existing ZKP challenge/proof widget. The actual code minting
// happens inside postVerify() (auth.controller.ts) once the proof passes —
// see oauthService.issueAuthorizationCode().

const authorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  response_type: z.literal('code'),
  scope: z.string().optional(),
  state: z.string().max(512).optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
}).strict();

export async function getAuthorize(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = authorizeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(`${first?.path.join('.') ?? 'param'}: ${first?.message}`);
    }
    const q = parsed.data;

    const validated = await oauthService.validateAuthorizeRequest({
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      responseType: q.response_type,
      scope: q.scope,
      state: q.state,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: q.code_challenge_method,
    });

    // Frontend uses this payload to render the ZKP login widget and to
    // carry the validated OAuth context through to the /auth/verify call
    // (typically as an opaque, signed `oauth_context` passed alongside the
    // proof submission — see auth.routes.ts postVerify for the consuming side).
    res.status(200).json({
      client_id: validated.clientId,
      redirect_uri: validated.redirectUri,
      scope: validated.scope,
      state: validated.state,
      oauth_context: {
        clientDbId: validated.clientDbId,
        redirectUri: validated.redirectUri,
        scope: validated.scope,
        state: validated.state,
        codeChallenge: validated.codeChallenge,
        codeChallengeMethod: validated.codeChallengeMethod,
      },
      message: 'Proceed with ZKP authentication (POST /auth/challenge, then /auth/verify with this oauth_context attached).',
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /oauth/token ──────────────────────────────────────────────────────

const tokenBodySchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  code_verifier: z.string().optional(),
}).strict();

export async function postToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = tokenBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(`${first?.path.join('.') ?? 'field'}: ${first?.message}`);
    }
    const b = parsed.data;

    const tokens = await oauthService.exchangeCodeForToken({
      grantType: b.grant_type,
      code: b.code,
      redirectUri: b.redirect_uri,
      clientId: b.client_id,
      clientSecret: b.client_secret,
      codeVerifier: b.code_verifier,
    });

    // RFC 6749 §5.1 response shape
    res.status(200).json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
    });
  } catch (err) {
    next(err);
  }
}
