/**
 * Risk Service — RiskScore Processing & Step-Up Trigger
 *
 * Sits between the gRPC stream response handler and the WebSocket client.
 * Receives a RiskScore from the LSTM service, evaluates it against thresholds,
 * updates Redis session state, writes to TimescaleDB, and optionally emits
 * a STEP_UP_REQUIRED event directly to the client's WebSocket connection.
 *
 * ─── Step-up trigger logic ────────────────────────────────────────────────────
 *   Score ≥ CRITICAL (0.90): Hard step-up — full ZKP re-authentication.
 *     1. Atomically set Redis session: step_up_required = true, level = HARD.
 *     2. Emit WS event: { type: STEP_UP_REQUIRED, payload: { required_level: HARD } }.
 *     3. The riskGateMiddleware will now block all subsequent authenticated requests
 *        until the step-up is resolved (Phase 6).
 *
 *   Score ≥ HIGH (0.75):   Soft step-up — re-enter PIN / TOTP.
 *     1. Atomically set Redis session: step_up_required = true, level = SOFT.
 *     2. Emit WS event: { type: STEP_UP_REQUIRED, payload: { required_level: SOFT } }.
 *
 *   Score < HIGH:          No action beyond Redis risk_level update.
 *
 * ─── EMA smoothing (T8 — model evasion mitigation) ───────────────────────────
 *   The smoothed score is already returned by the Python service (predictor.py).
 *   We apply a second-pass EMA here at the gateway level for any burst of scores
 *   arriving faster than the gRPC window cadence (e.g., multiple sessions pushing
 *   simultaneously). This creates a two-layer smoothing that further dampens
 *   adversarial single-window manipulation.
 *
 * ─── Redis mutation format ────────────────────────────────────────────────────
 *   Key: zkauth:session:{sessionId}
 *   Value: { userId, riskLevel, stepUpRequired, stepUpLevel?, createdAt }
 *
 *   Step-up pending key: zkauth:stepup:{sessionId}
 *   Value: { requiredLevel, issuedAt }
 *   TTL: STEP_UP_TTL_SECONDS (default 300s — user has 5 min to resolve)
 */

import { redis, RedisKeys } from '../../config/redis.js';
import { telemetryService } from '../telemetry/telemetry.service.js';
import { grpcCircuitBreaker, CircuitOpenError } from '../../grpc/circuitBreaker.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import type { RiskLevel, WsMessage, StepUpEvent } from '@zk-auth/types';
import type { WebSocket } from 'ws';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IncomingRiskScore {
  sessionId: string;
  userId: string;
  score: number;               // 0.0 → 1.0 (already EMA-smoothed by Python service)
  riskLevel: string;
  riskReason: string;
  evaluatedAtMs: number;
  eventsInWindow: number;
  modelVersion: string;
}

interface SessionCacheEntry {
  userId: string;
  riskLevel: RiskLevel;
  stepUpRequired: boolean;
  stepUpLevel?: 'SOFT' | 'HARD';
  createdAt: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class RiskService {
  /**
   * Process a risk score from the gRPC stream.
   *
   * @param score   — Incoming RiskScore from Python LSTM service
   * @param ws      — The client's WebSocket connection (for STEP_UP push)
   */
  async processScore(score: IncomingRiskScore, ws: WebSocket): Promise<void> {
    const { sessionId, userId, score: rawScore, riskLevel, riskReason, modelVersion, eventsInWindow } = score;

    // ── Circuit breaker guard ─────────────────────────────────────────────────
    // If the circuit is OPEN, the gRPC stream should not be producing scores.
    // If a score somehow arrives (e.g. last in-flight response before circuit
    // opened), we still process it but suppress step-up triggers — triggering
    // a step-up with a potentially stale or erroneous score during a service
    // degradation would lock out users unnecessarily.
    const circuitOpen = grpcCircuitBreaker.state !== 'CLOSED';
    if (circuitOpen) {
      logger.warn(
        { sessionId, circuitState: grpcCircuitBreaker.state },
        'Risk score received while circuit is not CLOSED — updating Redis only, suppressing step-up triggers',
      );
    }

    // ── 1. Classify into step-up tier ─────────────────────────────────────────
    // Only classify if circuit is CLOSED — suppress step-ups during degradation
    const stepUpLevel = circuitOpen ? null : this._classifyStepUp(rawScore);

    // ── 2. Atomic Redis session update ────────────────────────────────────────
    await this._updateSessionCache(sessionId, userId, riskLevel as RiskLevel, stepUpLevel);

    // ── 3. Write risk score to TimescaleDB (best-effort, async) ──────────────
    telemetryService
      .writeRiskScore({ sessionId, userId, score: rawScore, riskLevel, modelVersion, eventWindow: eventsInWindow })
      .catch((err) => logger.warn({ err, sessionId }, 'Risk score TimescaleDB write failed'));

    // ── 4. Push risk update to client (always — client may display a risk bar) ─
    this._pushRiskUpdate(ws, rawScore, riskLevel as RiskLevel, riskReason);

    // ── 5. If step-up required, set pending state and notify client ───────────
    if (stepUpLevel !== null) {
      await this._triggerStepUp(sessionId, stepUpLevel, rawScore, ws);
    }

    logger.debug(
      { sessionId, score: rawScore, riskLevel, riskReason, stepUpLevel },
      'Risk score processed',
    );
  }

  /**
   * Resolve a pending step-up (called after successful re-authentication).
   * Clears the step-up Redis key and resets the session risk level.
   */
  async resolveStepUp(sessionId: string, userId: string): Promise<void> {
    await redis.del(RedisKeys.stepUp(sessionId));

    const cached = await redis.get(RedisKeys.session(sessionId));
    if (cached !== null) {
      const entry = JSON.parse(cached) as SessionCacheEntry;
      entry.stepUpRequired = false;
      delete entry.stepUpLevel;
      entry.riskLevel = 'LOW';
      await redis.set(
        RedisKeys.session(sessionId),
        JSON.stringify(entry),
        'KEEPTTL',
      );
    }

    logger.info({ sessionId, userId }, 'Step-up resolved — session risk reset to LOW');
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private _classifyStepUp(score: number): 'SOFT' | 'HARD' | null {
    if (score >= env.RISK_STEP_UP_HARD_THRESHOLD) return 'HARD';
    if (score >= env.RISK_STEP_UP_SOFT_THRESHOLD) return 'SOFT';
    return null;
  }

  private async _updateSessionCache(
    sessionId: string,
    userId: string,
    riskLevel: RiskLevel,
    stepUpLevel: 'SOFT' | 'HARD' | null,
  ): Promise<void> {
    const key = RedisKeys.session(sessionId);
    const existing = await redis.get(key);

    const entry: SessionCacheEntry = existing
      ? (JSON.parse(existing) as SessionCacheEntry)
      : { userId, riskLevel, stepUpRequired: false, createdAt: Date.now() };

    entry.riskLevel = riskLevel;

    if (stepUpLevel !== null) {
      entry.stepUpRequired = true;
      entry.stepUpLevel = stepUpLevel;
    }

    // KEEPTTL preserves the original session expiry — don't extend on every risk update
    await redis
      .set(key, JSON.stringify(entry), 'KEEPTTL')
      .catch((err) => logger.warn({ err, sessionId }, 'Session cache risk update failed'));
  }

  private async _triggerStepUp(
    sessionId: string,
    level: 'SOFT' | 'HARD',
    score: number,
    ws: WebSocket,
  ): Promise<void> {
    // Idempotent: don't re-trigger if step-up already pending
    const existing = await redis.get(RedisKeys.stepUp(sessionId));
    if (existing !== null) {
      return; // already pending
    }

    const now = Date.now();
    const expiresAt = now + env.STEP_UP_TTL_SECONDS * 1_000;

    // Set step-up pending in Redis
    await redis
      .set(
        RedisKeys.stepUp(sessionId),
        JSON.stringify({ requiredLevel: level, issuedAt: now }),
        'EX', env.STEP_UP_TTL_SECONDS,
      )
      .catch((err) => logger.error({ err, sessionId }, 'Failed to set step-up Redis key'));

    // Emit STEP_UP_REQUIRED to the client WebSocket
    const stepUpPayload: StepUpEvent = {
      event: 'STEP_UP_REQUIRED',
      session_id: sessionId,
      risk_score: score,
      required_level: level,
      expires_at: expiresAt,
    };

    const wsMsg: WsMessage<StepUpEvent> = {
      type: 'STEP_UP_REQUIRED',
      payload: stepUpPayload,
      ts: now,
    };

    this._sendWsMessage(ws, wsMsg);

    logger.warn({ sessionId, level, score }, 'Step-up authentication triggered');
  }

  private _pushRiskUpdate(
    ws: WebSocket,
    score: number,
    riskLevel: RiskLevel,
    riskReason: string,
  ): void {
    const msg: WsMessage = {
      type: 'RISK_UPDATE',
      payload: { score, risk_level: riskLevel, risk_reason: riskReason },
      ts: Date.now(),
    };
    this._sendWsMessage(ws, msg);
  }

  private _sendWsMessage(ws: WebSocket, msg: WsMessage): void {
    // ws.readyState: OPEN = 1
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn({ err }, 'WebSocket send failed — client may have disconnected');
    }
  }
}

export const riskService = new RiskService();
