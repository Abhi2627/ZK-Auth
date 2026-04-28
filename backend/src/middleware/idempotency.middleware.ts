/**
 * Idempotency Middleware
 *
 * Intercepts requests carrying an `x-idempotency-key` header and caches
 * the server's response in Redis. Subsequent identical requests with the
 * same key return the cached response immediately — the handler never runs.
 *
 * ─── Why this prevents force-quit data loss ───────────────────────────────────
 *
 *   Client flow (web/mobile):
 *     1. Client generates a UUID (idempotency key) and stores it locally
 *        (IndexedDB on web, SQLite on Flutter) as a "pending intent".
 *     2. Client issues the request with X-Idempotency-Key: {uuid}.
 *     3. If the app crashes before receiving the response, the pending intent
 *        remains in local storage.
 *     4. On re-open, the background intent worker replays the request with the
 *        SAME uuid. The middleware finds the cached response in Redis and returns
 *        it without re-executing the handler — no duplicate credential, no
 *        double-charge, no ghost session.
 *
 * ─── Key schema ───────────────────────────────────────────────────────────────
 *   Redis key: zkauth:idem:{uuid}
 *   Value: JSON { statusCode, headers, body }
 *   TTL: IDEMPOTENCY_TTL_S (default 86400 = 24 hours)
 *
 * ─── Concurrency safety ───────────────────────────────────────────────────────
 *   Two concurrent requests with the same key (split-brain / retry storm):
 *   We use `SET NX` to acquire a processing lock. If the lock is already held,
 *   we return 409 Conflict with Retry-After: 2 — the client retries shortly and
 *   hits the cached response on its second attempt.
 *
 * ─── Applied selectively ──────────────────────────────────────────────────────
 *   Only POST / PUT / PATCH endpoints participate.
 *   GET and DELETE are inherently idempotent and skip this middleware.
 *   Endpoints that opt in by checking for the header — the middleware does nothing
 *   if the header is absent (existing non-idempotency-aware clients unaffected).
 */

import type { Request, Response, NextFunction } from 'express';
import { redis }    from '../config/redis.js';
import { logger }   from '../utils/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const IDEMPOTENCY_TTL_S   = 86_400;   // 24 hours
const PROCESSING_LOCK_TTL = 30;        // seconds — max handler execution time
const IDEMPOTENCY_HEADER  = 'x-idempotency-key';

// Regex for a valid UUID v4 — rejects arbitrary strings used as idempotency keys
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── Key builders ─────────────────────────────────────────────────────────────

function idemKey(uuid: string): string {
  return `idem:${uuid}`;
}

function lockKey(uuid: string): string {
  return `idem:lock:${uuid}`;
}

// ─── Cached response shape ────────────────────────────────────────────────────

interface CachedResponse {
  statusCode: number;
  headers:    Record<string, string>;
  body:       unknown;
}

// ─── Middleware factory ───────────────────────────────────────────────────────

export function idempotencyMiddleware() {
  return async function idempotency(
    req:  Request,
    res:  Response,
    next: NextFunction,
  ): Promise<void> {
    // Only apply to mutating methods
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      return next();
    }

    const rawKey = req.headers[IDEMPOTENCY_HEADER];
    if (!rawKey || typeof rawKey !== 'string') {
      // No idempotency key — pass through (not an error; key is optional)
      return next();
    }

    // Validate key format — reject non-UUIDs
    const key = rawKey.trim().toLowerCase();
    if (!UUID_RE.test(key)) {
      res.status(400).json({
        code:    'INVALID_IDEMPOTENCY_KEY',
        message: `${IDEMPOTENCY_HEADER} must be a valid UUID v4`,
      });
      return;
    }

    const redisCacheKey = idemKey(key);
    const redisLockKey  = lockKey(key);

    try {
      // ── 1. Check cache ─────────────────────────────────────────────────────
      const cached = await redis.get(redisCacheKey);
      if (cached !== null) {
        const parsed = JSON.parse(cached) as CachedResponse;

        // Replay original response headers (minus sensitive ones)
        Object.entries(parsed.headers).forEach(([name, value]) => {
          if (!['set-cookie', 'authorization'].includes(name.toLowerCase())) {
            res.setHeader(name, value);
          }
        });
        res.setHeader('X-Idempotency-Replayed', 'true');

        logger.info({ key, statusCode: parsed.statusCode }, 'Idempotency cache hit — replaying');
        res.status(parsed.statusCode).json(parsed.body);
        return;
      }

      // ── 2. Acquire processing lock (prevent concurrent identical requests) ──
      const lockAcquired = await redis.set(redisLockKey, '1', 'EX', PROCESSING_LOCK_TTL, 'NX');
      if (lockAcquired === null) {
        // Another request with the same key is currently being processed
        res.setHeader('Retry-After', '2');
        res.status(409).json({
          code:    'IDEMPOTENCY_CONFLICT',
          message: 'A request with this idempotency key is already being processed. Retry after 2s.',
        });
        return;
      }

      // ── 3. Intercept the response to cache it ──────────────────────────────
      const originalJson = res.json.bind(res) as (body: unknown) => Response;

      res.json = function (body: unknown): Response {
        // Capture the response before sending
        const statusCode = res.statusCode;

        // Only cache successful responses (2xx) and specific safe errors
        // Don't cache 429 / 503 — those are transient and should be retried fresh
        const shouldCache = statusCode >= 200 && statusCode < 300;

        if (shouldCache) {
          const headersToCache: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.getHeaders())) {
            if (typeof value === 'string') headersToCache[name] = value;
            if (typeof value === 'number') headersToCache[name] = String(value);
          }

          const toCache: CachedResponse = { statusCode, headers: headersToCache, body };

          // Fire-and-forget cache write — don't block the response
          redis.set(redisCacheKey, JSON.stringify(toCache), 'EX', IDEMPOTENCY_TTL_S)
            .then(() => redis.del(redisLockKey))
            .catch((err) => logger.error({ err, key }, 'Idempotency cache write failed'));
        } else {
          // Release lock without caching
          redis.del(redisLockKey).catch(() => {});
        }

        return originalJson(body);
      };

      next();

    } catch (err) {
      // Redis failure → fail open (pass through, no caching)
      logger.error({ err, key }, 'Idempotency middleware Redis error — failing open');
      next();
    }
  };
}
