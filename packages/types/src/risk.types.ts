// ─────────────────────────────────────────────────────────────────────────────
// ZK-Auth Shared Risk / Behavioral Telemetry Types
// ─────────────────────────────────────────────────────────────────────────────

import type { RiskLevel } from './auth.types.js';

export type BehaviorEventType =
  | 'MOUSE_MOVE'
  | 'KEY_DOWN'
  | 'KEY_UP'
  | 'SCROLL'
  | 'TOUCH'
  | 'FOCUS_LOSS';

export type RiskReason =
  | 'NORMAL'
  | 'ANOMALOUS_TYPING_RHYTHM'
  | 'VELOCITY_SPIKE'
  | 'VELOCITY_SPIKE_REVERSE'
  | 'SCROLL_ANOMALY'
  | 'TOUCH_PRESSURE_ANOMALY'
  | 'SEQUENCE_GAP_DETECTED'
  | 'FOCUS_LOSS_PATTERN'
  | 'MULTI_FACTOR_ANOMALY';

// ─── Telemetry Event (client → gateway → gRPC) ───────────────────────────────

export interface BehaviorEvent {
  session_id: string;
  timestamp_ms: number;
  event_type: BehaviorEventType;
  mouse_velocity?: number;    // px/ms
  key_dwell_ms?: number;      // ms
  scroll_delta?: number;
  touch_pressure?: number;    // 0.0–1.0 (mobile only)
  page_context?: string;      // SHA-256 of route — no raw PII
  sequence_num: number;       // monotonic counter per session
}

// ─── Risk Score (gRPC response → gateway → WebSocket push) ───────────────────

export interface RiskScoreResult {
  session_id: string;
  score: number;              // 0.0 → 1.0
  risk_level: RiskLevel;
  risk_reason: RiskReason;
  evaluated_at_ms: number;
  events_in_window: number;   // typically 50
  model_version: string;
}

// ─── WebSocket Message Envelope ──────────────────────────────────────────────

export type WsMessageType =
  | 'BEHAVIOR_EVENT'
  | 'RISK_UPDATE'
  | 'STEP_UP_REQUIRED'
  | 'SESSION_TERMINATED'
  | 'PING'
  | 'PONG';

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
  ts: number;  // client-side Unix epoch ms
}

export interface WsRiskUpdate {
  score: number;
  risk_level: RiskLevel;
  risk_reason: RiskReason;
}
