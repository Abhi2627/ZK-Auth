/**
 * Telemetry Handler — WebSocket event stream → gRPC pipe.
 *
 * Per-connection handler that:
 *  1. Validates incoming WsMessage<BehaviorEvent> frames.
 *  2. Forwards events to the LSTM gRPC bidirectional stream.
 *  3. Receives RiskScore responses and pushes them back to the client
 *     via a WsMessage<WsRiskUpdate> frame.
 *  4. Triggers step-up auth events when risk thresholds are crossed.
 *
 * Full implementation: Phase 3.
 */

import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

export function handleTelemetryConnection(ws: WebSocket, sessionId: string): void {
  logger.info({ sessionId }, 'Telemetry handler attached (Phase 3 pending)');

  ws.on('message', (_data) => {
    // Phase 3: parse BehaviorEvent, forward to gRPC stream
  });

  ws.on('close', (code, reason) => {
    logger.info({ sessionId, code, reason: reason.toString() }, 'Telemetry WS closed');
    // Phase 3: close gRPC stream, flush final risk score
  });

  ws.on('error', (err) => {
    logger.error({ err, sessionId }, 'Telemetry WS error');
  });
}
