/**
 * ZK-Auth API Gateway — Entry Point (Phase 5 — Telemetry DB added)
 */

import http from 'http';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { connectGrpc, disconnectGrpc } from './config/grpc.js';
import { attachWebSocketServer, closeAllConnections } from './websocket/wsServer.js';
import { zkpService } from './services/zkp/zkp.service.js';
import { disclosureService } from './services/credential/disclosure.service.js';
import { connectTelemetryDB, disconnectTelemetryDB } from './services/telemetry/telemetry.service.js';
import { telemetryService } from './services/telemetry/telemetry.service.js';
import { behaviorGrpcClient } from './grpc/behaviorClient.js';
import { logger } from './utils/logger.js';

async function bootstrap(): Promise<void> {
  logger.info({ env: env.NODE_ENV, port: env.PORT }, 'ZK-Auth API Gateway starting…');

  // ── Infrastructure ────────────────────────────────────────────────────────
  await connectDatabase();
  await connectRedis();
  await connectTelemetryDB();
  await connectGrpc();

  // ── ZKP services ──────────────────────────────────────────────────────────
  await zkpService.initialize();
  await disclosureService.initialize();

  // ── Application ───────────────────────────────────────────────────────────
  const app = createApp();
  const server = http.createServer(app);
  attachWebSocketServer(server);

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, pid: process.pid }, 'ZK-Auth API Gateway ready');
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received…');

    // 1. Stop accepting new WebSocket connections
    closeAllConnections();

    // 2. Close all active gRPC streams
    behaviorGrpcClient.closeAll();

    // 3. Flush any buffered telemetry to TimescaleDB
    await telemetryService.flush();

    server.close(async () => {
      try {
        await disconnectGrpc();
        await disconnectTelemetryDB();
        await disconnectRedis();
        await disconnectDatabase();
        logger.info('Clean shutdown complete.');
        process.exit(0);
      } catch (err) {
        logger.error(err, 'Error during shutdown');
        process.exit(1);
      }
    });

    setTimeout(() => {
      logger.error('Shutdown timeout — force exiting.');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => { logger.fatal(err, 'Uncaught exception'); shutdown('uncaughtException'); });
  process.on('unhandledRejection', (reason) => { logger.fatal({ reason }, 'Unhandled rejection'); shutdown('unhandledRejection'); });
}

bootstrap().catch((err) => {
  console.error('Fatal: bootstrap failed', err);
  process.exit(1);
});
