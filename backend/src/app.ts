/**
 * ZK-Auth API Gateway — Express Application Factory
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet      from 'helmet';
import cors        from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env }     from './config/env.js';
import { logger }  from './utils/logger.js';
import { AppError, ErrorCode } from './utils/errors.js';

import { authRouter }       from './routes/auth.routes.js';
import { credentialRouter } from './routes/credential.routes.js';
import { sessionRouter }    from './routes/session.routes.js';
import { issuerRouter }     from './routes/issuer.routes.js';
import { verifierRouter }   from './routes/verifier.routes.js';

export function createApp(): Express {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy:     env.NODE_ENV === 'production',
    crossOriginEmbedderPolicy: env.NODE_ENV === 'production',
  }));

  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new AppError(ErrorCode.FORBIDDEN, 'CORS: origin not allowed', 403));
      }
    },
    credentials:    true,
    methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Device-Label',
                     'X-Device-Fingerprint', 'X-Issuer-Token', 'X-Recovery-Token'],
    exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining',
                     'X-RateLimit-Reset'],
  }));

  app.use(express.json({ limit: '256kb' }));  // VPs can be larger than plain JSON
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());

  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/health' },
    customLogLevel: (_req, res) => {
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
  }));

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status:    'ok',
      service:   'zk-auth-gateway',
      timestamp: Date.now(),
      version:   process.env['npm_package_version'] ?? '0.0.0',
    });
  });

  // Core auth API
  app.use('/api/v1/auth',       authRouter);
  app.use('/api/v1/credential', credentialRouter);
  app.use('/api/v1/session',    sessionRouter);

  // Phase 9: Three-Actor Ecosystem (separate prefix — actor separation)
  app.use('/api/issuer',   issuerRouter);
  app.use('/api/verifier', verifierRouter);

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      code:      ErrorCode.NOT_FOUND,
      message:   `Route not found: ${req.method} ${req.path}`,
      trace:     (req as unknown as { id: string }).id ?? 'unknown',
      timestamp: Date.now(),
    });
  });

  // Global error handler
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const traceId = (req as unknown as { id?: string }).id ?? 'unknown';

    if (err instanceof AppError) {
      logger.warn({ err, traceId }, 'Application error');
      return res.status(err.statusCode).json({
        code:      err.code,
        message:   err.message,
        trace:     traceId,
        timestamp: Date.now(),
      });
    }

    logger.error({ err, traceId }, 'Unhandled error in request pipeline');
    return res.status(500).json({
      code:      ErrorCode.INTERNAL_ERROR,
      message:   'An unexpected error occurred.',
      trace:     traceId,
      timestamp: Date.now(),
    });
  });

  return app;
}
