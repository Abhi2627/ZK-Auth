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
  session_id:      string;
  timestamp_ms:    number;
  event_type:      BehaviorEventType;
  mouse_velocity?: number;
  key_dwell_ms?:   number;
  scroll_delta?:   number;
  touch_pressure?: number;
  page_context?:   string;
  sequence_num:    number;
}

// ─── Risk Score ───────────────────────────────────────────────────────────────

export interface RiskScoreResult {
  session_id:       string;
  score:            number;
  risk_level:       RiskLevel;
  risk_reason:      RiskReason;
  evaluated_at_ms:  number;
  events_in_window: number;
  model_version:    string;
}

// ─── WebSocket Message Envelope ──────────────────────────────────────────────

export type WsMessageType =
  | 'BEHAVIOR_EVENT'
  | 'RISK_UPDATE'
  | 'STEP_UP_REQUIRED'
  | 'STEP_UP_RESOLVED'
  | 'SESSION_TERMINATED'
  | 'PING'
  | 'PONG';

export interface WsMessage<T = unknown> {
  type:    WsMessageType;
  payload: T;
  ts:      number;
}

export interface WsRiskUpdate {
  score:       number;
  risk_level:  RiskLevel;
  risk_reason: RiskReason;
}

export interface WsStepUpResolved {
  session_id: string;
}
