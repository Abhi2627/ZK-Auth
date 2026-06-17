/**
 * Verification Request Notifier
 *
 * Bridges Redis pub/sub → WebSocket for the verifier real-time flow.
 *
 * When a holder approves or rejects a verification request:
 *   1. verifyRequest.controller publishes to Redis channel `vreq:{request_id}`
 *   2. This service (subscribed via psubscribe to vreq:*) receives it
 *   3. Looks up the verifier's WS session_id from _pending registry
 *   4. Calls pushToSession to deliver the live result
 *
 * The verifier portal registers its session via POST /api/verifier/watch/:requestId
 * immediately after generating a QR proof request.
 */

import Redis from 'ioredis';
import { env }           from '../../config/env.js';
import { logger }        from '../../utils/logger.js';
import { pushToSession } from '../../websocket/wsServer.js';

// ─── Pending registry ─────────────────────────────────────────────────────────

interface PendingEntry {
  verifierSessionId: string;
  expiresAt:         number;
}

const _pending = new Map<string, PendingEntry>();

setInterval(() => {
  const now = Date.now();
  _pending.forEach((entry, id) => {
    if (entry.expiresAt < now) _pending.delete(id);
  });
}, 60_000);

export function registerPendingVerifierRequest(
  requestId:         string,
  verifierSessionId: string,
  ttlMs             = 600_000,
): void {
  _pending.set(requestId, { verifierSessionId, expiresAt: Date.now() + ttlMs });
  logger.info({ requestId, verifierSessionId }, 'Verifier registered for live result push');
}

// ─── Redis subscriber ─────────────────────────────────────────────────────────

let _sub: Redis | null = null;

export async function initVerifyRequestNotifier(): Promise<void> {
  _sub = new Redis(env.REDIS_URL, {
    password:             env.REDIS_PASSWORD,
    keyPrefix:            '',         // pub/sub channels must NOT have keyPrefix
    maxRetriesPerRequest: null as unknown as number,
    enableOfflineQueue:   true,
    lazyConnect:          true,
  });

  _sub.on('error', err => logger.error(err, 'VReqNotifier Redis error'));

  _sub.on('pmessage', (_pattern: string, channel: string, raw: string) => {
    try {
      const requestId = channel.replace('vreq:', '');
      const entry     = _pending.get(requestId);
      if (!entry) return; // no verifier waiting — ignore

      const payload = JSON.parse(raw) as {
        status:           string;
        approved_claims?: string[];
        rejected_claims?: string[];
        reason?:          string;
        responded_at:     string;
      };

      const pushed = pushToSession(entry.verifierSessionId, {
        type: payload.status === 'APPROVED'
          ? 'VERIFY_REQUEST_APPROVED'
          : 'VERIFY_REQUEST_REJECTED',
        payload: {
          request_id:      requestId,
          status:          payload.status,
          approved_claims: payload.approved_claims ?? [],
          rejected_claims: payload.rejected_claims ?? [],
          reason:          payload.reason ?? null,
          responded_at:    payload.responded_at,
        },
        ts: Date.now(),
      });

      logger.info(
        { requestId, status: payload.status, pushed },
        pushed ? 'Live result pushed to verifier' : 'Verifier WS not open',
      );

      _pending.delete(requestId);
    } catch (err) {
      logger.error({ err }, 'VReqNotifier pmessage error');
    }
  });

  await _sub.connect();
  await _sub.psubscribe('vreq:*');
  logger.info('VReqNotifier subscribed to vreq:*');
}

export async function shutdownVerifyRequestNotifier(): Promise<void> {
  if (_sub) { await _sub.quit(); _sub = null; }
}
