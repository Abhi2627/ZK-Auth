// ─────────────────────────────────────────────────────────────────────────────
// ZK-Auth Shared Auth Types
// ─────────────────────────────────────────────────────────────────────────────

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFY';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export type ChallengeStatus = 'PENDING' | 'CONSUMED' | 'EXPIRED';

export type StepUpResolution = 'PASSED' | 'FAILED' | 'TIMED_OUT';

// ─── Groth16 Proof Shape ─────────────────────────────────────────────────────

export interface Groth16Proof {
  pi_a:     [string, string, string];
  pi_b:     [[string, string], [string, string], [string, string]];
  pi_c:     [string, string, string];
  protocol: 'groth16';
  curve:    'bn254';
}

// ─── Challenge / Nonce ───────────────────────────────────────────────────────

export interface ChallengeRequest {
  /** Optional: pre-identified user public key commitment */
  commitment_hash?: string;
}

export interface ChallengeResponse {
  challenge_id: string;  // UUID
  nonce: string;         // hex-encoded 32-byte nonce
  expires_at: number;    // Unix epoch ms
}

// ─── ZKP Proof Submission ────────────────────────────────────────────────────

export interface ProofSubmission {
  challenge_id: string;
  proof: Groth16Proof;
  /** [nullifier_hash, commitment_root] */
  public_signals: [string, string];
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;  // seconds
  session_id: string;
}

// ─── JWT Payload ─────────────────────────────────────────────────────────────

export interface JwtAccessPayload {
  sub: string;           // user_id (UUID)
  sid: string;           // session_id (UUID)
  risk: RiskLevel;
  iat: number;
  exp: number;
  type: 'access';
}

export interface JwtRefreshPayload {
  sub: string;           // user_id (UUID)
  sid: string;           // session_id (UUID)
  jti: string;           // JWT ID — used for rotation tracking
  iat: number;
  exp: number;
  type: 'refresh';
}

// ─── Step-Up Auth ────────────────────────────────────────────────────────────

export interface StepUpEvent {
  event: 'STEP_UP_REQUIRED';
  session_id: string;
  risk_score: number;
  required_level: 'SOFT' | 'HARD';
  expires_at: number;  // Unix epoch ms — 5 min window
}

// ─── API Error Envelope ──────────────────────────────────────────────────────

export interface ApiError {
  code: string;
  message: string;
  trace: string;  // correlation ID
  timestamp: number;
}
