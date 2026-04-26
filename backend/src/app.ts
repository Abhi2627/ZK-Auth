/**
 * ZK-Auth API Gateway — Express Application Factory
 *
 * Creates and configures the Express application instance.
 * Separated from index.ts so tests can import the app without
 * triggering side-effectful infrastructure connections.
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { AppError, ErrorCode } from './utils/errors.js';

// ─── Route Imports (stubs — populated in Phase 3) ────────────────────────────
import { authRouter } from './routes/auth.routes.js';
import { credentialRouter } from './routes/credential.routes.js';
import { sessionRouter } from './routes/session.routes.js';

// ─────────────────────────────────────────────────────────────────────────────

export function createApp(): Express {
  const app = express();

  // ─── Security Headers ───────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: env.NODE_ENV === 'production',
      crossOriginEmbedderPolicy: env.NODE_ENV === 'production',
    }),
  );

  // ─── CORS ───────────────────────────────────────────────────────────────
  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (e.g. server-to-server, mobile apps)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new AppError(ErrorCode.FORBIDDEN, 'CORS: origin not allowed', 403));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      exposedHeaders: ['X-Request-ID'],
    }),
  );

  // ─── Request Parsing ────────────────────────────────────────────────────
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());

  // ─── Structured HTTP Logging (Pino) ─────────────────────────────────────
  app.use(
    pinoHttp({
      logger,
      // Suppress health-check route logs to reduce noise
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
      customLogLevel: (_req, res) => {
        if (res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      genReqId: (req) =>
        (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
    }),
  );

  // ─── Health Check (unauthenticated) ─────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'zk-auth-gateway',
      timestamp: Date.now(),
      version: process.env['npm_package_version'] ?? '0.0.0',
    });
  });

  // ─── API Routes ─────────────────────────────────────────────────────────
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/credential', credentialRouter);
  app.use('/api/v1/session', sessionRouter);

  // ─── 404 Handler ────────────────────────────────────────────────────────
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      code: ErrorCode.NOT_FOUND,
      message: `Route not found: ${req.method} ${req.path}`,
      trace: (req as unknown as { id: string }).id ?? 'unknown',
      timestamp: Date.now(),
    });
  });

  // ─── Global Error Handler ────────────────────────────────────────────────
  // Express 5 async errors are forwarded automatically — no asyncHandler wrapper needed.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const traceId = (req as unknown as { id: string }).id ?? 'unknown';

    if (err instanceof AppError) {
      logger.warn({ err, traceId }, 'Application error');
      return res.status(err.statusCode).json({
        code: err.code,
        message: err.message,
        trace: traceId,
        timestamp: Date.now(),
      });
    }

    // Unexpected errors — do not leak internals to client
    logger.error({ err, traceId }, 'Unhandled error in request pipeline');
    return res.status(500).json({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
      trace: traceId,
      timestamp: Date.now(),
    });
  });

  return app;
}
