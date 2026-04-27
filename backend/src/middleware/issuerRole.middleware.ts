/**
 * Issuer Role Middleware
 *
 * Guards the /credential/issue and /credential/revoke endpoints.
 * Requires the authenticated session's JWT to carry role: 'issuer'.
 *
 * The 'issuer' role is encoded into the JWT at issuance time by the
 * admin bootstrapping flow (Phase 5). Regular user JWTs do not carry
 * this role and will be rejected with 403 FORBIDDEN.
 *
 * Must run AFTER authMiddleware (requires res.locals.session).
 */

import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// Extend the session type to include optional role
declare module 'express' {
  interface Locals {
    issuerRole?: boolean;
  }
}

export function requireIssuerRole(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // The issuer role is conveyed via a custom JWT claim 'role: issuer'.
  // The auth middleware decodes the JWT and attaches the full payload.
  // We read it from the Authorization header's decoded context here.
  // For Phase 4: we check a request header set by the admin service.
  // Phase 5 will replace this with a proper JWT role claim.

  // Temporary Phase 4 implementation: check X-Issuer-Token header
  // against an env-configured issuer secret. Replace in Phase 5 with
  // proper JWT role claim embedded in the access token.
  const issuerToken = req.headers['x-issuer-token'];
  const expectedToken = process.env['ISSUER_SECRET_TOKEN'];

  if (!expectedToken) {
    logger.error('ISSUER_SECRET_TOKEN not configured — issuer endpoints disabled');
    throw new ForbiddenError('Issuer endpoints not configured');
  }

  if (!issuerToken || issuerToken !== expectedToken) {
    logger.warn({ path: req.path }, 'Issuer role check failed — invalid or missing X-Issuer-Token');
    throw new ForbiddenError('Issuer role required');
  }

  next();
}
