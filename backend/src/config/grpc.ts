/**
 * gRPC Client Configuration — LSTM Inference Service.
 *
 * Establishes a gRPC channel to the Python ML microservice.
 * Supports both mTLS (production) and insecure (local dev) modes
 * controlled by the LSTM_GRPC_INSECURE env variable.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import fs from 'fs';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// ─── Proto Loading ────────────────────────────────────────────────────────────

const PROTO_PATH = path.resolve(
  __dirname,
  '../../../packages/proto/behavior.proto',
);

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
const BehaviorAnalyzer = protoDescriptor.zkauth.behavior.BehaviorAnalyzer;

// ─── Channel Credentials ─────────────────────────────────────────────────────

function buildCredentials(): grpc.ChannelCredentials {
  if (env.LSTM_GRPC_INSECURE) {
    logger.warn(
      'gRPC connecting to LSTM service with INSECURE credentials — dev only!',
    );
    return grpc.credentials.createInsecure();
  }

  if (!env.LSTM_CA_CERT_PATH || !env.LSTM_GRPC_CERT_PATH || !env.LSTM_GRPC_KEY_PATH) {
    throw new Error(
      'mTLS gRPC requires LSTM_CA_CERT_PATH, LSTM_GRPC_CERT_PATH, and LSTM_GRPC_KEY_PATH',
    );
  }

  const rootCert = fs.readFileSync(env.LSTM_CA_CERT_PATH);
  const clientCert = fs.readFileSync(env.LSTM_GRPC_CERT_PATH);
  const clientKey = fs.readFileSync(env.LSTM_GRPC_KEY_PATH);

  return grpc.credentials.createSsl(rootCert, clientKey, clientCert);
}

// ─── Singleton Client ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let grpcClient: any | null = null;

export function getGrpcClient() {
  if (!grpcClient) {
    throw new Error('gRPC client not initialised — call connectGrpc() first');
  }
  return grpcClient;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function connectGrpc(): Promise<void> {
  const target = `${env.LSTM_GRPC_HOST}:${env.LSTM_GRPC_PORT}`;
  const credentials = buildCredentials();

  grpcClient = new BehaviorAnalyzer(target, credentials, {
    'grpc.keepalive_time_ms': 30_000,
    'grpc.keepalive_timeout_ms': 10_000,
    'grpc.keepalive_permit_without_calls': 1,
  });

  // Verify connectivity with a health-check call
  await new Promise<void>((resolve, reject) => {
    grpcClient.HealthCheck({}, (err: grpc.ServiceError | null) => {
      if (err) {
        logger.error({ err, target }, 'gRPC health-check failed');
        reject(err);
      } else {
        logger.info({ target }, 'gRPC connected to LSTM inference service');
        resolve();
      }
    });
  });
}

export async function disconnectGrpc(): Promise<void> {
  if (grpcClient) {
    grpcClient.close();
    grpcClient = null;
    logger.info('gRPC client closed');
  }
}
