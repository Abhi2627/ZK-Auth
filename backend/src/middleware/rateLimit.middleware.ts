/**
 * Redis-backed Sliding Window Rate Limiter Middleware
 *
 * Algorithm: fixed-window counter with Redis INCR + EXPIRE.
 * Chosen over token bucket for simplicity at the cost of ~2x burst
 * at window boundaries — acceptable for auth endpoints where the limit
 * is 10–20 req/min, not 1000s/sec.
 *
 * Key schema: zkauth:ratelimit:{endpoint}:{identifier}
 *   identifier = IP address for unauthenticated endpoints
 *               = userId for authenticated endpoints (set by auth middleware)
 *
 * Behaviour:
 *   - First request in a window: INCR creates key, EXPIRE sets TTL = windowMs.
 *   - Subsequent requests: INCR increments; if count > limit → 429.
 *   - Window resets automatically when the key expires.
 *
 * Race safety: Redis INCR is atomic. Two concurrent requests will each get a
 * distinct count value — no double-counting.
 *
 * Headers returned:
 *   X-RateLimit-Limit:     max requests allowed in window
 *   X-RateLimit-Remaining: requests remaining in current window
 *   X-RateLimit-Reset:     Unix epoch seconds when window resets
 *   Retry-After:           seconds until window resets (on 429 only)
 */

import type { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { RateLimitError } from '../utils/errors.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RateLimitOptions {
  /** Endpoint label used in the Redis key, e.g. 'challenge', 'auth' */
  endpoint: string;
  /** Maximum requests allowed per window */
  limit: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /**
   * Key identifier function. Defaults to IP address.
   * Can be overridden to key by userId for authenticated endpoints.
   */
  identifier?: (req: Request) => string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function rateLimitMiddleware(options: RateLimitOptions) {
  const {
    endpoint,
    limit,
    windowSeconds,
    identifier = (req) => getClientIp(req),
  } = options;

  return async function rateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const id = identifier(req);

    if (!id) {
      // Cannot determine identifier — let the request through but log
      logger.warn({ endpoint }, 'Rate limiter could not determine client identifier');
      return next();
    }

    // Key structure: the Redis client prepends the global keyPrefix (zkauth:)
    const key = `ratelimit:${endpoint}:${id}`;

    try {
      // Atomic INCR: returns the new count after increment
      const count = await redis.incr(key);

      // Set TTL only on the first increment (key was just created)
      // INCR creates the key with value 1 if it didn't exist.
      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }

      // Calculate remaining TTL for headers
      const ttl = await redis.ttl(key);
      const resetAt = Math.floor(Date.now() / 1_000) + Math.max(ttl, 0);
      const remaining = Math.max(0, limit - count);

      // Set rate limit headers on every response
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(resetAt));

      if (count > limit) {
        res.setHeader('Retry-After', String(Math.max(ttl, 0)));
        logger.warn({ endpoint, id, count, limit }, 'Rate limit exceeded');
        throw new RateLimitError();
      }

      next();
    } catch (err) {
      if (err instanceof RateLimitError) {
        // Pass to global error handler
        next(err);
        return;
      }
      // Redis failure — fail open to avoid blocking all auth on Redis outage
      logger.error({ err, endpoint }, 'Rate limiter Redis error — failing open');
      next();
    }
  };
}

// ─── Pre-configured middleware instances ──────────────────────────────────────

import { env } from '../config/env.js';

/** Rate limiter for POST /auth/challenge — 10 req/min per IP */
export const challengeRateLimit = rateLimitMiddleware({
  endpoint: 'challenge',
  limit: env.RATE_LIMIT_CHALLENGE_PER_MIN,
  windowSeconds: 60,
});

/** Rate limiter for POST /auth/verify — 20 req/min per IP */
export const authVerifyRateLimit = rateLimitMiddleware({
  endpoint: 'auth',
  limit: env.RATE_LIMIT_AUTH_PER_MIN,
  windowSeconds: 60,
});

/** Rate limiter for POST /auth/refresh — 30 req/min per IP */
export const refreshRateLimit = rateLimitMiddleware({
  endpoint: 'refresh',
  limit: 30,
  windowSeconds: 60,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the real client IP from the request.
 * Checks X-Forwarded-For first (set by nginx/load-balancer).
 * Falls back to req.socket.remoteAddress.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    // X-Forwarded-For can be a comma-separated list; the leftmost is the client
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
