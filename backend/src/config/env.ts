/**
 * Environment Configuration — Zod-validated at startup.
 *
 * All downstream modules import `env` from here; direct `process.env`
 * access is prohibited to ensure type safety and fail-fast validation.
 */

import { z } from 'zod';

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Databases
  DATABASE_URL: z.string().url(),
  TIMESCALE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),
  REDIS_PASSWORD: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().default('zkauth'),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  JWT_ISSUER: z.string().default('zk-auth.internal'),
  JWT_AUDIENCE: z.string().default('zk-auth-clients'),

  // ZKP
  AUTH_CIRCUIT_VKEY_PATH: z.string(),
  DISCLOSURE_CIRCUIT_VKEY_PATH: z.string(),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  NULLIFIER_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(5),

  // gRPC
  LSTM_GRPC_HOST: z.string().default('localhost'),
  LSTM_GRPC_PORT: z.coerce.number().int().default(50051),
  LSTM_GRPC_CERT_PATH: z.string().optional(),
  LSTM_GRPC_KEY_PATH: z.string().optional(),
  LSTM_CA_CERT_PATH: z.string().optional(),
  LSTM_GRPC_INSECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // Risk
  RISK_THRESHOLD_MEDIUM: z.coerce.number().min(0).max(1).default(0.45),
  RISK_THRESHOLD_HIGH: z.coerce.number().min(0).max(1).default(0.75),
  RISK_THRESHOLD_CRITICAL: z.coerce.number().min(0).max(1).default(0.90),
  RISK_STEP_UP_SOFT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  RISK_STEP_UP_HARD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.90),
  RISK_EMA_ALPHA: z.coerce.number().min(0).max(1).default(0.3),

  // Rate Limiting
  RATE_LIMIT_CHALLENGE_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(20),

  // CORS
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // Session / WebSocket
  WS_PING_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  STEP_UP_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Recovery (Argon2id parameters)
  // Memory: 65536 KiB (64 MB) — defeats GPU attacks after DB exfiltration
  // Iterations: 3 passes — OWASP minimum for Argon2id
  // Parallelism: 1 — single-threaded verification matches server capacity
  ARGON2_MEMORY_KIB:   z.coerce.number().int().positive().default(65536),
  ARGON2_ITERATIONS:   z.coerce.number().int().positive().default(3),
  ARGON2_PARALLELISM:  z.coerce.number().int().positive().default(1),

  // Circuit breaker — ML service
  // If gRPC call exceeds this many ms, fail open (skip ML, allow ZKP-only auth)
  GRPC_TIMEOUT_MS:            z.coerce.number().int().positive().default(5_000),
  // Consecutive failures before opening the circuit
  GRPC_CIRCUIT_OPEN_THRESHOLD: z.coerce.number().int().positive().default(5),
  // How long (ms) to wait before attempting a probe after circuit opens
  GRPC_CIRCUIT_RESET_MS:       z.coerce.number().int().positive().default(30_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
