/**
 * WebSocket Server — HTTP upgrade handler.
 *
 * Attaches to the existing HTTP server created in index.ts.
 * Authenticates the upgrade handshake via JWT query parameter,
 * then delegates each connection to the telemetry handler.
 *
 * Full implementation: Phase 3.
 * This stub wires the upgrade event so the server starts cleanly.
 */

import http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

let wss: WebSocketServer | null = null;

export function attachWebSocketServer(server: http.Server): void {
  wss = new WebSocketServer({ noServer: true });

  // Handle HTTP → WebSocket upgrade requests
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', `http://${request.headers.host}`);

    if (pathname !== '/api/v1/session/telemetry') {
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss!.emit('connection', ws, request);
    });
  });

  wss.on('connection', (_ws: WebSocket, _request: http.IncomingMessage) => {
    // Phase 3: JWT auth handshake + telemetry pipe → gRPC
    logger.info('WebSocket connection established (Phase 3 handler pending)');
  });

  wss.on('error', (err) => {
    logger.error(err, 'WebSocket server error');
  });

  logger.info('WebSocket server attached to /api/v1/session/telemetry');
}

export function getWss(): WebSocketServer | null {
  return wss;
}
