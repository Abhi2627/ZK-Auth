/**
 * Telemetry Service — TimescaleDB Async Write Path
 *
 * Handles the high-throughput insert of raw BehaviorEvents into
 * telemetry.behavior_events (TimescaleDB hypertable).
 *
 * Design decisions:
 *   - Uses a raw pg Pool (NOT Prisma) for this path. TimescaleDB hypertables
 *     are invisible to Prisma's schema introspection. The telemetry DB lives
 *     on a separate connection string (TIMESCALE_URL) and a separate pool.
 *   - Write batching: events are buffered in memory per session and flushed
 *     every BATCH_INTERVAL_MS OR when the batch reaches BATCH_SIZE, whichever
 *     comes first. This prevents one INSERT per WebSocket frame under load.
 *   - Fire-and-forget: telemetry writes are non-blocking — a TimescaleDB write
 *     failure must NEVER propagate back to the WebSocket connection or gRPC stream.
 *     Failures are logged and the event is dropped. Historical data is best-effort;
 *     the real-time risk signal (gRPC) is the authoritative safety mechanism.
 *
 * Throughput target: ~500 events/sec per active user, ~1000 concurrent users.
 */

import pg from 'pg';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { BehaviorEvent } from '@zk-auth/types';

const { Pool } = pg;

// ─── Connection pool ──────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (_pool === null) {
    _pool = new Pool({
      connectionString: env.TIMESCALE_URL,
      max: 10,                    // max 10 connections for telemetry writes
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on('error', (err) => {
      logger.error(err, 'TimescaleDB pool error');
    });
  }
  return _pool;
}

export async function connectTelemetryDB(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    logger.info('TimescaleDB (telemetry) connected');
  } finally {
    client.release();
  }
}

export async function disconnectTelemetryDB(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    logger.info('TimescaleDB (telemetry) disconnected');
  }
}

// ─── Batch buffer ─────────────────────────────────────────────────────────────

const BATCH_SIZE = 50;
const BATCH_INTERVAL_MS = 500;

interface BufferedEvent {
  event: BehaviorEvent;
  sessionId: string;
  userId: string;
}

const _buffer: BufferedEvent[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (_flushTimer !== null) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushBuffer().catch((err) =>
      logger.error(err, 'Telemetry batch flush error'),
    );
  }, BATCH_INTERVAL_MS);
}

async function flushBuffer(): Promise<void> {
  if (_buffer.length === 0) return;

  const batch = _buffer.splice(0, _buffer.length);

  const pool = getPool();

  // Build parameterised bulk INSERT
  // telemetry.behavior_events columns:
  // time, session_id, user_id, event_type, mouse_velocity,
  // key_dwell_ms, scroll_delta, touch_pressure, page_context, sequence_num
  const values: unknown[] = [];
  const placeholders: string[] = [];

  batch.forEach((item, i) => {
    const offset = i * 10;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, ` +
      `$${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, ` +
      `$${offset + 9}, $${offset + 10})`,
    );

    const e = item.event;
    values.push(
      new Date(e.timestamp_ms),          // time
      item.sessionId,                    // session_id
      item.userId,                       // user_id
      e.event_type,                      // event_type
      e.mouse_velocity ?? null,          // mouse_velocity
      e.key_dwell_ms ?? null,            // key_dwell_ms
      e.scroll_delta ?? null,            // scroll_delta
      e.touch_pressure ?? null,          // touch_pressure
      e.page_context ?? null,            // page_context
      e.sequence_num,                    // sequence_num
    );
  });

  const sql = `
    INSERT INTO telemetry.behavior_events
      (time, session_id, user_id, event_type, mouse_velocity,
       key_dwell_ms, scroll_delta, touch_pressure, page_context, sequence_num)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT DO NOTHING
  `;

  try {
    await pool.query(sql, values);
    logger.debug({ count: batch.length }, 'Telemetry batch flushed to TimescaleDB');
  } catch (err) {
    // Best-effort: log and discard. Never throw — telemetry is not safety-critical.
    logger.error({ err, count: batch.length }, 'Telemetry batch write failed — events dropped');
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class TelemetryService {
  /**
   * Buffer a BehaviorEvent for async batch write to TimescaleDB.
   * Non-blocking — returns immediately. Flushes when buffer fills or timer fires.
   */
  bufferEvent(event: BehaviorEvent, sessionId: string, userId: string): void {
    _buffer.push({ event, sessionId, userId });

    if (_buffer.length >= BATCH_SIZE) {
      // Buffer full — flush immediately (cancel pending timer to avoid double flush)
      if (_flushTimer !== null) {
        clearTimeout(_flushTimer);
        _flushTimer = null;
      }
      flushBuffer().catch((err) =>
        logger.error(err, 'Telemetry immediate flush error'),
      );
    } else {
      scheduleFlush();
    }
  }

  /**
   * Write a risk score to telemetry.risk_scores.
   * Called by risk.service.ts when a RiskScore is received from gRPC.
   */
  async writeRiskScore(params: {
    sessionId: string;
    userId: string;
    score: number;
    riskLevel: string;
    modelVersion: string;
    eventWindow: number;
  }): Promise<void> {
    const pool = getPool();
    try {
      await pool.query(
        `INSERT INTO telemetry.risk_scores
           (time, session_id, user_id, risk_score, risk_level, model_version, event_window)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          new Date(),
          params.sessionId,
          params.userId,
          params.score,
          params.riskLevel,
          params.modelVersion,
          params.eventWindow,
        ],
      );
    } catch (err) {
      // Best-effort — never propagate
      logger.warn({ err, sessionId: params.sessionId }, 'Risk score write to TimescaleDB failed');
    }
  }

  /**
   * Flush any remaining buffered events immediately.
   * Called during graceful shutdown.
   */
  async flush(): Promise<void> {
    if (_flushTimer !== null) {
      clearTimeout(_flushTimer);
      _flushTimer = null;
    }
    await flushBuffer();
  }
}

export const telemetryService = new TelemetryService();
