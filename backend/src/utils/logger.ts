/**
 * Pino Structured Logger
 *
 * Single logger instance used across the entire backend.
 * In production, outputs newline-delimited JSON.
 * In development, pino-pretty is used for human-readable output.
 */

import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  base: {
    pid: process.pid,
    service: 'zk-auth-gateway',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // Never log sensitive fields
    paths: [
      'access_token',
      'refresh_token',
      'proof',
      'secret',
      'password',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      '*.token',
      '*.proof_json',
    ],
    censor: '[REDACTED]',
  },
});
