/**
 * Redis Configuration — ioredis singleton.
 *
 * Redis is used for:
 *  - Challenge nonce cache (TTL-based, SETNX)
 *  - Nullifier SET (append-only, SADD/SISMEMBER)
 *  - Session state cache
 *  - Rate-limit sliding windows
 *  - Real-time risk score cache
 *  - Step-up pending state
 */

import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// ─── Singleton ───────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | undefined;
}

function createRedisClient(): Redis {
  const client = new Redis(env.REDIS_URL, {
    password: env.REDIS_PASSWORD,
    keyPrefix: `${env.REDIS_KEY_PREFIX}:`,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 10) return null; // Stop retrying after 10 attempts
      return Math.min(times * 200, 3_000);
    },
    enableOfflineQueue: false,
    lazyConnect: true,
  });

  client.on('error', (err) => logger.error(err, 'Redis client error'));
  client.on('reconnecting', () => logger.warn('Redis reconnecting…'));
  client.on('ready', () => logger.info('Redis client ready'));

  return client;
}

export const redis: Redis = globalThis.__redis ?? createRedisClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__redis = redis;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
    await redis.ping();
    logger.info('Redis connected');
  } catch (err) {
    logger.fatal(err, 'Failed to connect to Redis');
    throw err;
  }
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  logger.info('Redis disconnected');
}

// ─── Key Builders ─────────────────────────────────────────────────────────────
// Centralised key construction — never build keys inline in service code.

export const RedisKeys = {
  challenge: (challengeId: string) => `challenge:${challengeId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  nullifiers: () => 'nullifiers',
  nullifierLock: (hash: string) => `lock:nullifier:${hash}`,
  rateLimitChallenge: (ip: string) => `ratelimit:challenge:${ip}`,
  rateLimitAuth: (ip: string) => `ratelimit:auth:${ip}`,
  riskScore: (sessionId: string) => `risk:${sessionId}`,
  stepUp: (sessionId: string) => `stepup:${sessionId}`,
} as const;
