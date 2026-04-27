/**
 * WebSocket Server — HTTP Upgrade with JWT Authentication
 *
 * Attaches to the HTTP server and guards the upgrade handshake with JWT
 * validation BEFORE the WebSocket connection is established.
 * An unauthenticated upgrade attempt is rejected with HTTP 401 at the
 * TCP level — no WebSocket frame is ever sent to an unauthenticated client.
 *
 * ─── Authentication flow ──────────────────────────────────────────────────────
 *   Client sends upgrade request to: /api/v1/session/telemetry?token=<JWT>
 *   (Bearer in URL query param — Authorization header is unavailable during
 *    the WebSocket upgrade handshake in browser environments.)
 *
 *   1. Extract JWT from the ?token= query parameter.
 *   2. Verify with sessionService.verifyAccessToken().
 *   3. If invalid: socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy().
 *   4. If valid: pass to wss.handleUpgrade(); emit 'connection' with session context.
 *
 * ─── Connection registry ──────────────────────────────────────────────────────
 *   _connections Map<sessionId, WebSocket> allows:
 *     - O(1) lookup when pushing server-initiated events (step-up triggers)
 *     - Deterministic cleanup when gRPC stream errors require client notification
 *     - Graceful drain on server shutdown (close all before process.exit)
 *
 * ─── Memory management ────────────────────────────────────────────────────────
 *   On 'close' or 'error':
 *     1. Remove from _connections registry.
 *     2. Call behaviorGrpcClient.close(sessionId) — half-closes the gRPC stream.
 *        This triggers cleanup of the Python-side SlidingWindow for that session.
 *     3. The ping interval for this connection is cleared (no zombie timers).
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { sessionService } from '../services/session/session.service.js';
import { handleTelemetryConnection } from './telemetryHandler.js';
import { behaviorGrpcClient } from '../grpc/behaviorClient.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import type { JwtAccessPayload } from '@zk-auth/types';

// ─── Connection registry ──────────────────────────────────────────────────────

export interface WsSessionContext {
  sessionId: string;
  userId: string;
  connectedAt: number;
  pingInterval: ReturnType<typeof setInterval> | null;
}

const _connections = new Map<string, WebSocket>();
const _contexts    = new Map<string, WsSessionContext>();

/** Push a message to a specific session's WebSocket. Returns false if not found. */
export function pushToSession(sessionId: string, message: object): boolean {
  const ws = _connections.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/** Get number of active WebSocket connections (for health endpoint). */
export function activeConnectionCount(): number {
  return _connections.size;
}

// ─── Server ───────────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;

export function attachWebSocketServer(server: http.Server): void {
  wss = new WebSocketServer({ noServer: true });

  // ── HTTP upgrade handler ──────────────────────────────────────────────────
  server.on('upgrade', async (request, socket, head) => {
    const reqUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? 'localhost'}`,
    );

    // Only handle our telemetry path
    if (reqUrl.pathname !== '/api/v1/session/telemetry') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Extract JWT from query string
    const token = reqUrl.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n');
      socket.destroy();
      logger.warn({ ip: socket.remoteAddress }, 'WS upgrade rejected: no token');
      return;
    }

    // Verify JWT
    let decoded: JwtAccessPayload;
    try {
      decoded = await sessionService.verifyAccessToken(token);
    } catch (err) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n');
      socket.destroy();
      logger.warn({ err }, 'WS upgrade rejected: invalid token');
      return;
    }

    // Reject if session already has an open WS connection
    // (prevents duplicate streams from same session — client reconnect is fine
    //  after the old one is cleaned up, but simultaneous tabs would duplicate telemetry)
    if (_connections.has(decoded.sid)) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      logger.warn({ sessionId: decoded.sid }, 'WS upgrade rejected: session already connected');
      return;
    }

    // Handshake
    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request, decoded);
    });
  });

  // ── Connection handler ────────────────────────────────────────────────────
  wss.on('connection', (ws: WebSocket, _request: http.IncomingMessage, decoded: JwtAccessPayload) => {
    const { sid: sessionId, sub: userId } = decoded;

    // Register connection
    _connections.set(sessionId, ws);
    const ctx: WsSessionContext = {
      sessionId,
      userId,
      connectedAt: Date.now(),
      pingInterval: null,
    };
    _contexts.set(sessionId, ctx);

    logger.info({ sessionId, userId }, 'WebSocket connection established');

    // Open gRPC stream for this session
    behaviorGrpcClient.open(sessionId, userId, ws);

    // Start telemetry message handler
    handleTelemetryConnection(ws, sessionId, userId);

    // Keepalive ping
    ctx.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, env.WS_PING_INTERVAL_MS);

    // ── Disconnect cleanup ──────────────────────────────────────────────────
    const cleanup = (reason: string) => {
      logger.info({ sessionId, reason }, 'WebSocket disconnected — cleaning up');

      // 1. Clear keepalive timer
      const c = _contexts.get(sessionId);
      if (c?.pingInterval) clearInterval(c.pingInterval);

      // 2. Remove from registry
      _connections.delete(sessionId);
      _contexts.delete(sessionId);

      // 3. Close gRPC stream → triggers Python SlidingWindow cleanup
      behaviorGrpcClient.close(sessionId);
    };

    ws.on('close', (code, reason) => cleanup(`close(${code}):${reason.toString()}`));
    ws.on('error', (err) => {
      logger.warn({ err, sessionId }, 'WebSocket error');
      cleanup('error');
    });
  });

  wss.on('error', (err) => logger.error(err, 'WebSocket server error'));

  logger.info('WebSocket server attached to /api/v1/session/telemetry');
}

/** Close all WebSocket connections. Called during graceful shutdown. */
export function closeAllConnections(): void {
  const count = _connections.size;
  _connections.forEach((ws, sessionId) => {
    behaviorGrpcClient.close(sessionId);
    ws.terminate();
  });
  _connections.clear();
  _contexts.clear();
  logger.info({ count }, 'All WebSocket connections terminated on shutdown');
}

export function getWss(): WebSocketServer | null {
  return wss;
}
