/**
 * Risk Gate Middleware
 *
 * Checks the current session risk level on every request to protected routes.
 * If step-up auth is pending, blocks the request with 403 STEP_UP_REQUIRED.
 *
 * This middleware runs AFTER authMiddleware (requires res.locals.session).
 */

import type { Request, Response, NextFunction } from 'express';
import { redis, RedisKeys } from '../config/redis.js';
import { StepUpRequiredError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface StepUpCacheEntry {
  requiredLevel: 'SOFT' | 'HARD';
  issuedAt: number;
}

export async function riskGateMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const session = res.locals['session'];

  if (!session) {
    // authMiddleware must run first
    return next();
  }

  try {
    const raw = await redis.get(RedisKeys.stepUp(session.sessionId));

    if (raw !== null) {
      const stepUp = JSON.parse(raw) as StepUpCacheEntry;
      logger.warn(
        { sessionId: session.sessionId, requiredLevel: stepUp.requiredLevel },
        'Step-up authentication required for this request',
      );
      throw new StepUpRequiredError();
    }

    next();
  } catch (err) {
    next(err);
  }
}
