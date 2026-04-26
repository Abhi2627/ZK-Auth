/**
 * JWT Authentication Middleware
 *
 * Validates Bearer tokens on every protected route and attaches the
 * decoded session context to res.locals for downstream handlers.
 *
 * Flow:
 *   1. Extract Bearer token from Authorization header.
 *   2. Call sessionService.verifyAccessToken() which:
 *        a. Verifies JWT signature (HS256) and expiry.
 *        b. Checks session revocation via Redis (fast) or PG (fallback).
 *        c. Returns decoded payload with live risk level.
 *   3. Attach payload to res.locals.session.
 *   4. Pass to next() — business logic reads from res.locals.session.
 *
 * If the token is missing, expired, or revoked:
 *   → 401 with an appropriate ErrorCode (TOKEN_EXPIRED vs. INVALID_TOKEN).
 *
 * res.locals shape after this middleware:
 *   res.locals.session: AuthenticatedSession
 */

import type { Request, Response, NextFunction } from 'express';
import { sessionService } from '../services/session/session.service.js';
import { logger } from '../utils/logger.js';
import { UnauthorizedError } from '../utils/errors.js';
import type { JwtAccessPayload, RiskLevel } from '@zk-auth/types';

// ─── Augmented request context ────────────────────────────────────────────────

export interface AuthenticatedSession {
  userId: string;
  sessionId: string;
  riskLevel: RiskLevel;
}

// Extend Express res.locals type
declare global {
  namespace Express {
    interface Locals {
      session: AuthenticatedSession;
    }
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const raw = extractBearerToken(req);

    if (!raw) {
      throw new UnauthorizedError('Authorization header missing or malformed');
    }

    const decoded: JwtAccessPayload = await sessionService.verifyAccessToken(raw);

    // Attach to res.locals for downstream controllers
    res.locals['session'] = {
      userId: decoded.sub,
      sessionId: decoded.sid,
      riskLevel: decoded.risk,
    } satisfies AuthenticatedSession;

    // Update last_active_at in PG asynchronously — don't block the request
    // The prisma update is fire-and-forget; failures are logged, not thrown.
    updateLastActive(decoded.sid).catch((err) =>
      logger.warn({ err, sessionId: decoded.sid }, 'Non-critical: last_active_at update failed'),
    );

    next();
  } catch (err) {
    next(err);
  }
}

// ─── Optional auth middleware (doesn't reject if no token) ───────────────────

/**
 * Same as authMiddleware but doesn't throw if no token is present.
 * Used on routes that have different behaviour for authenticated vs anonymous
 * callers (e.g., public endpoints with optional personalisation).
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const raw = extractBearerToken(req);

  if (!raw) {
    return next();
  }

  try {
    const decoded: JwtAccessPayload = await sessionService.verifyAccessToken(raw);
    res.locals['session'] = {
      userId: decoded.sub,
      sessionId: decoded.sid,
      riskLevel: decoded.risk,
    } satisfies AuthenticatedSession;
  } catch {
    // Silently ignore — token present but invalid, treat as unauthenticated
  }

  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractBearerToken(req: Request): string | null {
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string') return null;

  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
    return null;
  }

  return parts[1];
}

import { prisma } from '../config/database.js';

async function updateLastActive(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  });
}
