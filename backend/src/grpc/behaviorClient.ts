/**
 * gRPC Behavior Client — with Circuit Breaker
 *
 * Manages bidirectional gRPC streams to the Python LSTM service.
 * Wraps ALL gRPC operations through the CircuitBreaker singleton.
 *
 * ─── Circuit breaker integration ─────────────────────────────────────────────
 *   Every operation that touches the gRPC channel is wrapped in
 *   grpcCircuitBreaker.call(fn). When the circuit OPENS:
 *
 *   open()  → catches CircuitOpenError → logs ML_UNAVAILABLE warning
 *             → returns without creating a stream (session has no ML scoring)
 *
 *   write() → stream entry may be null if open() was skipped
 *             → silently drops the event (no crash, no user impact)
 *
 *   close() → safely no-ops if no stream was created
 *
 *   This is the FAIL-OPEN guarantee:
 *     - Core ZKP auth (challenge/verify/nullifier) has zero dependency on gRPC
 *     - Users continue to authenticate normally
 *     - Risk scoring defaults to the last known Redis value (LOW on new sessions)
 *     - Step-up triggers are paused until the circuit CLOSES
 *     - The circuit probes recovery with one test call after RESET_MS (30s default)
 *
 * ─── Health metric ────────────────────────────────────────────────────────────
 *   GET /health (extended in Phase 9) will expose circuit state so ops teams
 *   can see "ML service: OPEN — circuit tripped at 14:32:05" in dashboards.
 *
 * ─── Backpressure ─────────────────────────────────────────────────────────────
 *   write() returns false when the kernel send buffer is full.
 *   We buffer up to 500 events per session and drop oldest on overflow.
 */

import * as grpc from '@grpc/grpc-js';
import { getGrpcClient }          from '../config/grpc.js';
import { riskService, type IncomingRiskScore } from '../services/session/risk.service.js';
import { grpcCircuitBreaker, CircuitOpenError } from './circuitBreaker.js';
import { logger }                 from '../utils/logger.js';
import type { WebSocket }         from 'ws';
import type { BehaviorEvent }     from '@zk-auth/types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StreamEntry {
  stream:       grpc.ClientDuplexStream<unknown, unknown>;
  sessionId:    string;
  userId:       string;
  ws:           WebSocket;
  draining:     boolean;
  pendingQueue: unknown[];
  openedAt:     number;
  lastEventAt:  number;
}

// ─── Proto message builder ─────────────────────────────────────────────────────

function toBehaviorEventProto(event: BehaviorEvent, sessionId: string): Record<string, unknown> {
  return {
    session_id:     sessionId,
    timestamp_ms:   event.timestamp_ms,
    event_type:     event.event_type,
    mouse_velocity: event.mouse_velocity  ?? 0,
    key_dwell_ms:   event.key_dwell_ms    ?? 0,
    scroll_delta:   event.scroll_delta    ?? 0,
    touch_pressure: event.touch_pressure  ?? 0,
    page_context:   event.page_context    ?? '',
    sequence_num:   event.sequence_num,
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const _streams = new Map<string, StreamEntry>();

// ─── Client ───────────────────────────────────────────────────────────────────

export class BehaviorGrpcClient {

  /**
   * Open a bidirectional stream for a session.
   *
   * If the circuit is OPEN the stream is NOT created — the session simply has
   * no ML scoring for its lifetime. This is the fail-open path: the user
   * authenticates via ZKP only and gets a LOW risk default.
   */
  open(sessionId: string, userId: string, ws: WebSocket): void {
    if (_streams.has(sessionId)) {
      logger.warn({ sessionId }, 'Stream already open — skipping re-open');
      return;
    }

    // Attempt stream creation through circuit breaker
    grpcCircuitBreaker
      .call(() => this._createStream(sessionId, userId, ws))
      .catch((err) => {
        if (err instanceof CircuitOpenError) {
          logger.warn(
            { sessionId, circuitState: grpcCircuitBreaker.state },
            'ML_SERVICE_UNAVAILABLE: gRPC circuit OPEN — session will operate without behavioral scoring. ZKP auth unaffected.',
          );
          return; // Fail open — do NOT throw, do NOT block the WebSocket connection
        }
        // Non-circuit error (e.g. getGrpcClient() fails at startup)
        logger.error(
          { err, sessionId },
          'Failed to open gRPC stream — behavioral scoring unavailable for this session',
        );
      });
  }

  /**
   * Write a BehaviorEvent to the session's gRPC stream.
   * Silently no-ops if the circuit is open or stream was never created.
   */
  write(sessionId: string, event: BehaviorEvent): void {
    const entry = _streams.get(sessionId);
    if (!entry) {
      // Circuit was open when session started — silently drop
      return;
    }

    entry.lastEventAt = Date.now();
    const proto = toBehaviorEventProto(event, sessionId);

    if (entry.draining) {
      entry.pendingQueue.push(proto);
      if (entry.pendingQueue.length > 500) {
        entry.pendingQueue.shift();
        logger.warn({ sessionId }, 'gRPC backpressure queue overflow — dropping oldest event');
      }
      return;
    }

    const canWrite = entry.stream.write(proto);
    if (!canWrite) {
      entry.draining = true;
    }
  }

  /**
   * Close the gRPC stream for a session.
   * Safe to call even if no stream was ever created (circuit was open).
   */
  close(sessionId: string): void {
    const entry = _streams.get(sessionId);
    if (!entry) return;

    try {
      entry.stream.end();
    } catch (err) {
      logger.warn({ err, sessionId }, 'Error ending gRPC stream gracefully');
    }

    _streams.delete(sessionId);
    logger.info({ sessionId }, 'gRPC behavior stream closed');
  }

  /**
   * Close all open streams. Called during server graceful shutdown.
   */
  closeAll(): void {
    const count = _streams.size;
    logger.info({ count }, 'Closing all gRPC streams on shutdown');
    Array.from(_streams.keys()).forEach((id) => this.close(id));
  }

  get activeStreamCount(): number { return _streams.size; }

  /** Expose circuit state for health endpoint. */
  get circuitState() {
    return {
      state:        grpcCircuitBreaker.state,
      failureCount: grpcCircuitBreaker.failureCount,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async _createStream(
    sessionId: string,
    userId:    string,
    ws:        WebSocket,
  ): Promise<void> {
    const grpcClient = getGrpcClient();
    const stream     = grpcClient.StreamEvents() as grpc.ClientDuplexStream<unknown, unknown>;

    const entry: StreamEntry = {
      stream,
      sessionId,
      userId,
      ws,
      draining:     false,
      pendingQueue: [],
      openedAt:     Date.now(),
      lastEventAt:  Date.now(),
    };

    stream.on('data', (riskScoreProto: Record<string, unknown>) => {
      this._handleRiskScore(riskScoreProto, entry);
    });

    stream.on('error', (err: grpc.ServiceError) => {
      logger.error(
        { code: err.code, message: err.message, sessionId },
        'gRPC stream error — removing session stream',
      );
      // Record failure in circuit breaker so it can trip if threshold is reached
      // We record via a failed dummy call rather than accessing private internals
      grpcCircuitBreaker
        .call(() => Promise.reject(err))
        .catch(() => {/* circuit recorded the failure */});

      _streams.delete(sessionId);
    });

    stream.on('end', () => {
      logger.info({ sessionId }, 'gRPC stream ended by server');
      _streams.delete(sessionId);
    });

    stream.on('drain', () => {
      const e = _streams.get(sessionId);
      if (!e) return;
      e.draining = false;
      this._flushPendingQueue(e);
    });

    _streams.set(sessionId, entry);
    logger.info({ sessionId, userId }, 'gRPC behavior stream opened');
  }

  private _handleRiskScore(
    proto: Record<string, unknown>,
    entry: StreamEntry,
  ): void {
    const score: IncomingRiskScore = {
      sessionId:      String(proto['session_id']       ?? entry.sessionId),
      userId:         entry.userId,
      score:          Number(proto['score']            ?? 0),
      riskLevel:      String(proto['risk_level']       ?? 'LOW'),
      riskReason:     String(proto['risk_reason']      ?? 'NORMAL').replace(/_+$/, ''), // strip padding
      evaluatedAtMs:  Number(proto['evaluated_at_ms']  ?? Date.now()),
      eventsInWindow: Number(proto['events_in_window'] ?? 0),
      modelVersion:   String(proto['model_version']    ?? 'unknown'),
    };

    riskService.processScore(score, entry.ws).catch((err) =>
      logger.error({ err, sessionId: entry.sessionId }, 'Risk score processing error'),
    );
  }

  private _flushPendingQueue(entry: StreamEntry): void {
    while (entry.pendingQueue.length > 0 && !entry.draining) {
      const proto    = entry.pendingQueue.shift();
      const canWrite = entry.stream.write(proto);
      if (!canWrite) {
        entry.draining = true;
        break;
      }
    }
  }
}

export const behaviorGrpcClient = new BehaviorGrpcClient();
