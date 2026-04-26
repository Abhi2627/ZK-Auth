/**
 * ZK-Auth API Gateway — Entry Point
 *
 * Responsibilities:
 *  1. Validate environment configuration at startup (fail-fast).
 *  2. Initialise all infrastructure connections (DB, Redis, gRPC).
 *  3. Initialise ZKP service (load vKey into memory).
 *  4. Create the Express application and attach the HTTP server.
 *  5. Attach the WebSocket server to the HTTP server upgrade event.
 *  6. Start listening and register graceful-shutdown handlers.
 */

import http from 'http';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { connectGrpc, disconnectGrpc } from './config/grpc.js';
import { attachWebSocketServer } from './websocket/wsServer.js';
import { zkpService } from './services/zkp/zkp.service.js';
import { logger } from './utils/logger.js';

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  logger.info({ env: env.NODE_ENV, port: env.PORT }, 'ZK-Auth API Gateway starting…');

  // 1. Connect to all infrastructure (fail-fast on any error)
  await connectDatabase();
  await connectRedis();
  await connectGrpc();

  // 2. Initialise ZKP service — load vKey into memory once
  await zkpService.initialize();

  // 3. Build Express application
  const app = createApp();

  // 4. Create HTTP server (needed to share with WebSocket server)
  const server = http.createServer(app);

  // 5. Attach WebSocket upgrade handler
  attachWebSocketServer(server);

  // 6. Start listening
  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, pid: process.pid },
      'ZK-Auth API Gateway ready',
    );
  });

  // ─── Graceful Shutdown ────────────────────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received, draining connections…');

    server.close(async () => {
      try {
        await disconnectGrpc();
        await disconnectRedis();
        await disconnectDatabase();
        logger.info('All connections closed. Exiting cleanly.');
        process.exit(0);
      } catch (err) {
        logger.error(err, 'Error during graceful shutdown');
        process.exit(1);
      }
    });

    setTimeout(() => {
      logger.error('Graceful shutdown timed out after 15s. Force-exiting.');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal(err, 'Uncaught exception — shutting down');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection — shutting down');
    shutdown('unhandledRejection');
  });
}

bootstrap().catch((err) => {
  console.error('Fatal: bootstrap failed', err);
  process.exit(1);
});
