/**
 * Database Configuration — Prisma Client singleton.
 *
 * A single PrismaClient instance is reused across the process lifetime.
 * Connection is verified at startup via `$connect()`; disconnect is
 * called during graceful shutdown.
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

// ─── Singleton ───────────────────────────────────────────────────────────────

declare global {
  // Prevent multiple PrismaClient instances in hot-reload (tsx watch) dev mode
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__prisma ??
  new PrismaClient({
    log: [
      { level: 'query', emit: 'event' },
      { level: 'warn',  emit: 'stdout' },
      { level: 'error', emit: 'stdout' },
    ],
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__prisma = prisma;
}

// Log slow queries in development
if (process.env['NODE_ENV'] === 'development') {
  // @ts-expect-error — Prisma event typing requires specific versions
  prisma.$on('query', (e: { query: string; duration: number }) => {
    if (e.duration > 200) {
      logger.warn({ query: e.query, duration_ms: e.duration }, 'Slow Prisma query');
    }
  });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    // Verify connection with a lightweight query
    await prisma.$queryRaw`SELECT 1`;
    logger.info('PostgreSQL (Prisma) connected');
  } catch (err) {
    logger.fatal(err, 'Failed to connect to PostgreSQL');
    throw err;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('PostgreSQL (Prisma) disconnected');
}
