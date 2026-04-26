/**
 * Global Error Handler Middleware
 *
 * Serialises AppError instances and unexpected errors into a consistent
 * JSON envelope. Already wired into app.ts — this file exists so the
 * handler can be unit-tested in isolation.
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function errorHandlerMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const traceId = (req as unknown as { id?: string }).id ?? 'unknown';

  if (err instanceof AppError) {
    logger.warn({ err, traceId, path: req.path }, 'Application error');
    res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      trace: traceId,
      timestamp: Date.now(),
    });
    return;
  }

  logger.error({ err, traceId, path: req.path }, 'Unhandled error');
  res.status(500).json({
    code: ErrorCode.INTERNAL_ERROR,
    message: 'An unexpected error occurred.',
    trace: traceId,
    timestamp: Date.now(),
  });
}
