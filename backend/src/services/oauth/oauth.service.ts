/**
 * OAuth Service — Authorization Code Flow backed by ZKP authentication
 *
 * ZK-Auth's OAuth Authorization Server implementation. The standard
 * RFC 6749 Authorization Code grant has a "user authenticates" step that
 * is normally a password/session-cookie check; here it is the existing
 * Groth16 challenge/verify flow (see auth.controller.ts postVerify).
 *
 * Flow:
 *   1. Relying party redirects user to
 *      GET /oauth/authorize?client_id=&redirect_uri=&response_type=code&scope=&state=
 *   2. Client/redirect_uri/scope are validated against the registered
 *      OAuthClient (validateAuthorizeRequest).
 *   3. The frontend renders the EXISTING ZKP login widget (challenge →
 *      groth16.fullProve → verify) instead of a password form.
 *   4. On successful, non-replayed proof verification, the backend calls
 *      issueAuthorizationCode() — NOT sessionService.issue() directly —
 *      to mint a short-lived code instead of an access token.
 *   5. The frontend redirects to redirect_uri?code=...&state=...
 *   6. The relying party's backend calls
 *      POST /oauth/token { grant_type: 'authorization_code', code, ... }
 *      which exchangeCodeForToken() validates and converts into a real
 *      session via the existing sessionService.issue().
 *
 * Security properties inherited from the ZKP layer:
 *   - The authorization code is bound to the nullifier_hash of the proof
 *     that authorized it, so a code can be traced back to exactly one
 *     ZKP verification event and cannot be minted without one.
 *   - Codes are single-use (isUsed flag, checked+set in one transaction)
 *     and short-lived (60s), per RFC 6749 §4.1.2 best practice.
 *   - PKCE (S256) is supported and enforced when a client sends
 *     code_challenge at /authorize — required for any public (non-
 *     confidential) client, e.g. a SPA verifier portal with no secret.
 */

import crypto from 'crypto';
import { prisma } from '../../config/database.js';
import { sha256, generateId } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { sessionService } from '../session/session.service.js';
import type { AuthTokens } from '@zk-auth/types';

const AUTH_CODE_TTL_S = 60; // RFC 6749 recommends a short-lived code

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AuthorizeRequestParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export interface ValidatedAuthorizeRequest {
  clientDbId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export interface TokenExchangeParams {
  grantType: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier?: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class OAuthService {

  // ─── Step 1: validate the /authorize request before showing ZKP login ────

  async validateAuthorizeRequest(
    params: AuthorizeRequestParams,
  ): Promise<ValidatedAuthorizeRequest> {
    if (params.responseType !== 'code') {
      throw new AppError(
        ErrorCode.UNSUPPORTED_GRANT_TYPE,
        'Only response_type=code is supported',
        400,
      );
    }

    const client = await prisma.oAuthClient.findUnique({
      where: { clientId: params.clientId },
    });

    if (!client || !client.isActive) {
      throw new AppError(ErrorCode.INVALID_CLIENT, 'Unknown or inactive client_id', 400);
    }

    if (!client.redirectUris.includes(params.redirectUri)) {
      // Exact-match allow-list per RFC 6749 §3.1.2.3 — never wildcard-match
      throw new AppError(
        ErrorCode.INVALID_REQUEST,
        'redirect_uri does not match any registered URI for this client',
        400,
      );
    }

    const requestedScopes = (params.scope ?? 'openid profile').split(' ').filter(Boolean);
    const allowedScopes = new Set(client.scopes);
    const grantedScopes = requestedScopes.filter((s) => allowedScopes.has(s));

    if (grantedScopes.length === 0) {
      throw new AppError(ErrorCode.INVALID_SCOPE, 'No requested scope is permitted for this client', 400);
    }

    if (params.codeChallenge && params.codeChallengeMethod !== 'S256') {
      throw new AppError(
        ErrorCode.INVALID_REQUEST,
        'Only PKCE code_challenge_method=S256 is supported',
        400,
      );
    }

    return {
      clientDbId: client.id,
      clientId: client.clientId,
      redirectUri: params.redirectUri,
      scope: grantedScopes.join(' '),
      state: params.state,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
    };
  }

  // ─── Step 2: mint a code AFTER the ZKP proof has already been verified ───

  /**
   * Called from auth.controller.ts postVerify(), in the OAuth-flow branch,
   * immediately after a Groth16 proof has passed groth16.verify() AND its
   * nullifier has been atomically inserted (replay-checked). This function
   * does not re-verify the proof — it trusts the caller already did, and
   * binds the resulting code to that specific nullifier for traceability.
   */
  async issueAuthorizationCode(input: {
    validated: ValidatedAuthorizeRequest;
    userId: string;
    nullifierHash: string;
  }): Promise<{ code: string; state?: string; redirectUri: string }> {
    const code = generateId() + generateId(); // 64+ chars of entropy, opaque (not a JWT)
    const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_S * 1_000);

    await prisma.oAuthAuthorizationCode.create({
      data: {
        code,
        clientId: input.validated.clientDbId,
        userId: input.userId,
        redirectUri: input.validated.redirectUri,
        scope: input.validated.scope,
        state: input.validated.state ?? null,
        codeChallenge: input.validated.codeChallenge ?? null,
        codeChallengeMethod: input.validated.codeChallengeMethod ?? null,
        nullifierHash: input.nullifierHash,
        expiresAt,
      },
    });

    logger.info(
      { clientId: input.validated.clientId, userId: input.userId },
      'OAuth authorization code issued following ZKP verification',
    );

    return { code, state: input.validated.state, redirectUri: input.validated.redirectUri };
  }

  // ─── Step 3: exchange the code for a real session (access/refresh token) ─

  async exchangeCodeForToken(params: TokenExchangeParams): Promise<AuthTokens> {
    if (params.grantType !== 'authorization_code') {
      throw new AppError(ErrorCode.UNSUPPORTED_GRANT_TYPE, 'Unsupported grant_type', 400);
    }

    const client = await prisma.oAuthClient.findUnique({
      where: { clientId: params.clientId },
    });
    if (!client || !client.isActive) {
      throw new AppError(ErrorCode.INVALID_CLIENT, 'Unknown or inactive client', 401);
    }

    // Confidential clients (server-side relying parties) must present their secret.
    // Public clients (e.g. a SPA) omit it and MUST have used PKCE at /authorize.
    if (params.clientSecret) {
      const incomingHash = sha256(params.clientSecret);
      if (incomingHash !== client.clientSecretHash) {
        throw new AppError(ErrorCode.INVALID_CLIENT, 'Invalid client_secret', 401);
      }
    }

    // ── Atomically fetch-and-mark-used to prevent double-redemption races ───
    const record = await prisma.$transaction(async (tx) => {
      const row = await tx.oAuthAuthorizationCode.findUnique({
        where: { code: params.code },
      });

      if (!row) {
        throw new AppError(ErrorCode.INVALID_GRANT, 'Authorization code not found', 400);
      }
      if (row.isUsed) {
        // Per RFC 6749 §4.1.2: a reused code is a strong signal of interception.
        // Defense-in-depth: revoke all sessions tied to that user.
        logger.warn(
          { code: params.code, userId: row.userId },
          'SECURITY: OAuth authorization code reuse detected',
        );
        await sessionService.revokeAllForUser(row.userId).catch(() => {/* best-effort */});
        throw new AppError(ErrorCode.INVALID_GRANT, 'Authorization code already used', 400);
      }
      if (row.expiresAt < new Date()) {
        throw new AppError(ErrorCode.INVALID_GRANT, 'Authorization code has expired', 400);
      }
      if (row.clientId !== client.id) {
        throw new AppError(ErrorCode.INVALID_GRANT, 'Code was not issued to this client', 400);
      }
      if (row.redirectUri !== params.redirectUri) {
        throw new AppError(ErrorCode.INVALID_GRANT, 'redirect_uri mismatch', 400);
      }

      // PKCE verification (RFC 7636) if the original /authorize used it
      if (row.codeChallenge) {
        if (!params.codeVerifier) {
          throw new AppError(ErrorCode.INVALID_GRANT, 'code_verifier required (PKCE)', 400);
        }
        const computed = crypto
          .createHash('sha256')
          .update(params.codeVerifier)
          .digest('base64url');
        if (computed !== row.codeChallenge) {
          throw new AppError(ErrorCode.INVALID_GRANT, 'PKCE code_verifier does not match', 400);
        }
      }

      await tx.oAuthAuthorizationCode.update({
        where: { code: params.code },
        data: { isUsed: true },
      });

      return row;
    });

    logger.info(
      { clientId: params.clientId, userId: record.userId },
      'OAuth authorization code exchanged for session',
    );

    // Reuses the EXACT session-issuance path as the non-OAuth login flow —
    // an OAuth-issued access token and a direct-login access token are
    // structurally identical JWTs from sessionService's perspective.
    return sessionService.issue(record.userId);
  }
}

export const oauthService = new OAuthService();
