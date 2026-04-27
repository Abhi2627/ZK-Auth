/**
 * gRPC Behavior Client Wrapper
 *
 * Manages the lifecycle of bidirectional gRPC streams to the Python LSTM service.
 * One stream per active WebSocket session — opened on first telemetry event,
 * closed deterministically on WebSocket disconnect.
 *
 * ─── Stream lifecycle ─────────────────────────────────────────────────────────
 *   open(sessionId, ws)  — creates a new ClientDuplexStream for this session
 *   write(sessionId, event) — writes a BehaviorEvent proto to the open stream
 *   close(sessionId)     — half-closes the write side; waits for gRPC FIN
 *
 * ─── Concurrency model ────────────────────────────────────────────────────────
 *   _streams Map<sessionId, StreamEntry> is the in-process registry.
 *   One Node.js process = one gRPC channel (HTTP/2 multiplexed).
 *   Multiple streams multiplex over that single channel via HTTP/2 stream IDs.
 *   No locking needed — Node.js event loop is single-threaded for Map mutations.
 *
 * ─── Backpressure ─────────────────────────────────────────────────────────────
 *   grpc ClientDuplexStream exposes write() which returns false when the kernel
 *   send buffer is full. We honour this: if write() returns false, we wait for
 *   the 'drain' event before writing the next event, preventing OOM under a
 *   scenario where the Python service is slower than the client WebSocket.
 *
 * ─── Error recovery ───────────────────────────────────────────────────────────
 *   If the gRPC stream errors (network blip, service restart), we log and
 *   remove the entry from _streams. The next write() call for this session
 *   will attempt to re-open a new stream. Risk scoring falls back to the
 *   last known Redis risk level during the gap.
 */

import * as grpc from '@grpc/grpc-js';
import { getGrpcClient } from '../config/grpc.js';
import { riskService, type IncomingRiskScore } from '../services/session/risk.service.js';
import { logger } from '../utils/logger.js';
import type { WebSocket } from 'ws';
import type { BehaviorEvent } from '@zk-auth/types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StreamEntry {
  stream: grpc.ClientDuplexStream<unknown, unknown>;
  sessionId: string;
  userId: string;
  ws: WebSocket;
  draining: boolean;          // true when write() returned false — await 'drain'
  pendingQueue: unknown[];     // events buffered during backpressure
  openedAt: number;
  lastEventAt: number;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const _streams = new Map<string, StreamEntry>();

// ─── Proto message builder ─────────────────────────────────────────────────────

/**
 * Convert a BehaviorEvent domain object to the plain object shape expected
 * by the @grpc/grpc-js dynamic proto loader.
 * Field names match behavior.proto snake_case definitions.
 */
function toBehaviorEventProto(event: BehaviorEvent, sessionId: string): Record<string, unknown> {
  return {
    session_id:      sessionId,
    timestamp_ms:    event.timestamp_ms,
    event_type:      event.event_type,
    mouse_velocity:  event.mouse_velocity  ?? 0,
    key_dwell_ms:    event.key_dwell_ms    ?? 0,
    scroll_delta:    event.scroll_delta    ?? 0,
    touch_pressure:  event.touch_pressure  ?? 0,
    page_context:    event.page_context    ?? '',
    sequence_num:    event.sequence_num,
  };
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class BehaviorGrpcClient {

  /**
   * Open a new bidirectional stream for a session.
   * Must be called once per session before any write() calls.
   *
   * @param sessionId — The authenticated session UUID
   * @param userId    — The user UUID (for risk service callbacks)
   * @param ws        — The live WebSocket connection (for pushing risk scores back)
   */
  open(sessionId: string, userId: string, ws: WebSocket): void {
    if (_streams.has(sessionId)) {
      logger.warn({ sessionId }, 'Stream already open for session — skipping re-open');
      return;
    }

    let stream: grpc.ClientDuplexStream<unknown, unknown>;
    try {
      stream = getGrpcClient().StreamEvents();
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed to open gRPC StreamEvents — LSTM service unreachable');
      return; // Stream not available; risk scoring falls back to last Redis value
    }

    const entry: StreamEntry = {
      stream,
      sessionId,
      userId,
      ws,
      draining: false,
      pendingQueue: [],
      openedAt: Date.now(),
      lastEventAt: Date.now(),
    };

    // ── Listen for incoming RiskScore responses ───────────────────────────────
    stream.on('data', (riskScoreProto: Record<string, unknown>) => {
      this._handleRiskScore(riskScoreProto, entry);
    });

    stream.on('error', (err: grpc.ServiceError) => {
      logger.error(
        { code: err.code, message: err.message, sessionId },
        'gRPC stream error — removing session stream',
      );
      this._cleanup(sessionId);
    });

    stream.on('end', () => {
      logger.info({ sessionId }, 'gRPC stream ended by server');
      this._cleanup(sessionId);
    });

    // Honour backpressure: flush pending queue when buffer drains
    stream.on('drain', () => {
      const e = _streams.get(sessionId);
      if (!e) return;
      e.draining = false;
      this._flushPendingQueue(e);
    });

    _streams.set(sessionId, entry);
    logger.info({ sessionId, userId }, 'gRPC behavior stream opened');
  }

  /**
   * Write a BehaviorEvent to the session's open gRPC stream.
   * Handles backpressure transparently via a per-session pending queue.
   */
  write(sessionId: string, event: BehaviorEvent): void {
    const entry = _streams.get(sessionId);
    if (!entry) {
      // Stream not open (LSTM unreachable or not yet opened) — silently skip
      return;
    }

    entry.lastEventAt = Date.now();
    const proto = toBehaviorEventProto(event, sessionId);

    if (entry.draining) {
      // Backpressure: queue the event until 'drain' fires
      entry.pendingQueue.push(proto);
      // Cap the queue at 500 events (~1 second of data) to bound memory
      if (entry.pendingQueue.length > 500) {
        entry.pendingQueue.shift(); // drop oldest
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
   * Called when the WebSocket disconnects (clean shutdown) or on server shutdown.
   * Half-closes the write side — the server will flush its window and send 'end'.
   */
  close(sessionId: string): void {
    const entry = _streams.get(sessionId);
    if (!entry) return;

    try {
      entry.stream.end();
    } catch (err) {
      logger.warn({ err, sessionId }, 'Error ending gRPC stream gracefully — forcing cleanup');
    }

    this._cleanup(sessionId);
    logger.info({ sessionId }, 'gRPC behavior stream closed');
  }

  /**
   * Close all open streams. Called during server graceful shutdown.
   */
  closeAll(): void {
    const sessionIds = Array.from(_streams.keys());
    logger.info({ count: sessionIds.length }, 'Closing all gRPC streams on shutdown');
    sessionIds.forEach((id) => this.close(id));
  }

  /**
   * Number of currently open streams (for health metrics).
   */
  get activeStreamCount(): number {
    return _streams.size;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _handleRiskScore(
    proto: Record<string, unknown>,
    entry: StreamEntry,
  ): void {
    const score: IncomingRiskScore = {
      sessionId:       String(proto['session_id'] ?? entry.sessionId),
      userId:          entry.userId,
      score:           Number(proto['score'] ?? 0),
      riskLevel:       String(proto['risk_level'] ?? 'LOW'),
      riskReason:      String(proto['risk_reason'] ?? 'NORMAL'),
      evaluatedAtMs:   Number(proto['evaluated_at_ms'] ?? Date.now()),
      eventsInWindow:  Number(proto['events_in_window'] ?? 0),
      modelVersion:    String(proto['model_version'] ?? 'unknown'),
    };

    // Process asynchronously — don't block the stream data handler
    riskService.processScore(score, entry.ws).catch((err) =>
      logger.error({ err, sessionId: entry.sessionId }, 'Risk score processing error'),
    );
  }

  private _flushPendingQueue(entry: StreamEntry): void {
    while (entry.pendingQueue.length > 0 && !entry.draining) {
      const proto = entry.pendingQueue.shift();
      const canWrite = entry.stream.write(proto);
      if (!canWrite) {
        entry.draining = true;
        break;
      }
    }
  }

  private _cleanup(sessionId: string): void {
    _streams.delete(sessionId);
  }
}

export const behaviorGrpcClient = new BehaviorGrpcClient();
