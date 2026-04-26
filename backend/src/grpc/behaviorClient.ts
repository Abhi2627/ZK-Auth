/**
 * gRPC Behavior Client Wrapper
 *
 * Thin typed wrapper around the raw gRPC client from config/grpc.ts.
 * Service layer imports this — never the raw gRPC client directly —
 * so the gRPC transport detail stays encapsulated here.
 *
 * Full typed implementation after proto codegen in Phase 3.
 */

import * as grpc from '@grpc/grpc-js';
import { getGrpcClient } from '../config/grpc.js';
import { logger } from '../utils/logger.js';

/**
 * Open a bidirectional gRPC stream for behavioral event scoring.
 * Returns the duplex call object; caller manages write() and 'data' events.
 */
export function openBehaviorStream(): grpc.ClientDuplexStream<unknown, unknown> {
  const client = getGrpcClient();
  const stream = client.StreamEvents();

  stream.on('error', (err: grpc.ServiceError) => {
    logger.error({ code: err.code, message: err.message }, 'gRPC behavior stream error');
  });

  return stream;
}

/**
 * Unary call: get current session risk score snapshot.
 * Phase 3 will add proper typing from generated proto stubs.
 */
export async function getSessionRisk(sessionId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    getGrpcClient().GetSessionRisk({ session_id: sessionId }, (err: grpc.ServiceError | null, response: unknown) => {
      if (err) return reject(err);
      resolve(response);
    });
  });
}
