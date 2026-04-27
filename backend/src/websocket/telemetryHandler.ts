/**
 * Telemetry Connection Handler — Dual-Write Pipeline
 *
 * Called once per authenticated WebSocket connection.
 * Routes each incoming BehaviorEvent through two parallel paths:
 *
 *   Path A — gRPC stream (real-time):
 *     behaviorGrpcClient.write(sessionId, event)
 *     → Python LSTM service → RiskScore → riskService.processScore()
 *     → Redis session update + optional STEP_UP_REQUIRED WS push
 *
 *   Path B — TimescaleDB (historical):
 *     telemetryService.bufferEvent(event, sessionId, userId)
 *     → batched INSERT to telemetry.behavior_events
 *     → used by offline LSTM retraining pipeline
 *
 * Both paths are fire-and-forget from the perspective of the WebSocket handler.
 * A write failure on either path MUST NOT close the WebSocket connection.
 *
 * ─── Message framing ──────────────────────────────────────────────────────────
 *   All WS messages use the WsMessage<T> envelope from @zk-auth/types:
 *     { type: WsMessageType, payload: T, ts: number }
 *
 *   Valid incoming types from client:
 *     BEHAVIOR_EVENT  — behavioral telemetry event
 *     PING            — keepalive (server responds with PONG)
 *
 *   Outgoing types from server:
 *     PONG            — keepalive response
 *     RISK_UPDATE     — current risk score (sent after each gRPC window)
 *     STEP_UP_REQUIRED — authentication upgrade required
 *     SESSION_TERMINATED — server-initiated disconnect
 *
 * ─── Sequence validation ─────────────────────────────────────────────────────
 *   Each BehaviorEvent carries a monotonic sequence_num per session.
 *   Gaps are detected (sequence_num - lastSeqNum > 1) and logged.
 *   The gRPC stream receives all events including gap-flagged ones;
 *   the Python feature extractor handles sequence gaps as a feature dimension.
 */

import type { WebSocket } from 'ws';
import { behaviorGrpcClient } from '../grpc/behaviorClient.js';
import { telemetryService } from '../services/telemetry/telemetry.service.js';
import { logger } from '../utils/logger.js';
import type { WsMessage, BehaviorEvent } from '@zk-auth/types';

// ─── Per-connection state ─────────────────────────────────────────────────────

interface ConnectionState {
  lastSeqNum: number;
  eventCount: number;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handleTelemetryConnection(
  ws: WebSocket,
  sessionId: string,
  userId: string,
): void {
  const state: ConnectionState = {
    lastSeqNum: -1,
    eventCount: 0,
  };

  ws.on('message', (raw: Buffer | string) => {
    let msg: WsMessage<unknown>;

    // ── Parse envelope ──────────────────────────────────────────────────────
    try {
      msg = JSON.parse(raw.toString()) as WsMessage<unknown>;
    } catch {
      logger.warn({ sessionId }, 'WS: malformed JSON — ignoring frame');
      return;
    }

    if (!msg.type) {
      logger.warn({ sessionId }, 'WS: missing message type — ignoring');
      return;
    }

    // ── Dispatch by type ────────────────────────────────────────────────────
    switch (msg.type) {
      case 'BEHAVIOR_EVENT':
        handleBehaviorEvent(msg.payload as BehaviorEvent, sessionId, userId, state, ws);
        break;

      case 'PING':
        // Respond with PONG — application-level keepalive (separate from WS ping frames)
        safeSend(ws, { type: 'PONG', payload: {}, ts: Date.now() });
        break;

      default:
        logger.debug({ sessionId, type: msg.type }, 'WS: unknown message type — ignoring');
    }
  });
}

// ─── BehaviorEvent handler ────────────────────────────────────────────────────

function handleBehaviorEvent(
  event: BehaviorEvent,
  sessionId: string,
  userId: string,
  state: ConnectionState,
  ws: WebSocket,
): void {
  // ── Structural validation ────────────────────────────────────────────────
  if (!isValidBehaviorEvent(event)) {
    logger.warn({ sessionId, event }, 'WS: invalid BehaviorEvent payload — ignoring');
    return;
  }

  // ── Sequence gap detection ───────────────────────────────────────────────
  if (state.lastSeqNum >= 0 && event.sequence_num > state.lastSeqNum + 1) {
    const gap = event.sequence_num - state.lastSeqNum - 1;
    logger.debug({ sessionId, gap, seqNum: event.sequence_num }, 'Sequence gap detected');
    // Gap is passed as-is to gRPC; Python feature_extractor uses sequence_gap dimension
  }
  state.lastSeqNum = event.sequence_num;
  state.eventCount++;

  // ── Path A: gRPC stream (real-time risk inference) ────────────────────────
  // Non-blocking — write() returns immediately (backpressure handled in behaviorClient)
  behaviorGrpcClient.write(sessionId, event);

  // ── Path B: TimescaleDB buffer (historical retraining) ───────────────────
  // bufferEvent() is synchronous — pushes to in-memory buffer, flushes in background
  telemetryService.bufferEvent(event, sessionId, userId);
}

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_EVENT_TYPES = new Set([
  'MOUSE_MOVE', 'KEY_DOWN', 'KEY_UP', 'SCROLL', 'TOUCH', 'FOCUS_LOSS',
]);

function isValidBehaviorEvent(e: unknown): e is BehaviorEvent {
  if (typeof e !== 'object' || e === null) return false;
  const ev = e as Record<string, unknown>;

  return (
    typeof ev['session_id']    === 'string' &&
    typeof ev['timestamp_ms']  === 'number' &&
    typeof ev['event_type']    === 'string' && VALID_EVENT_TYPES.has(ev['event_type'] as string) &&
    typeof ev['sequence_num']  === 'number' && Number.isInteger(ev['sequence_num']) &&
    ev['sequence_num'] >= 0
  );
}

// ─── Safe send ────────────────────────────────────────────────────────────────

function safeSend(ws: WebSocket, msg: object): void {
  if (ws.readyState !== 1) return; // OPEN = 1
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Ignore — client may have disconnected
  }
}
