export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFY';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type ChallengeStatus = 'PENDING' | 'CONSUMED' | 'EXPIRED';
export type StepUpResolution = 'PASSED' | 'FAILED' | 'TIMED_OUT';
export interface Groth16Proof {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
    protocol: 'groth16';
    /**
     * snarkjs's groth16.fullProve() emits curve: "bn128", NOT "bn254" — same
     * curve (alt_bn128 / Ethereum EIP-196/197 naming vs. the more common
     * "BN254" name referring to the curve's ~254-bit prime field size).
     * Accept both spellings.
     */
    curve: 'bn128' | 'bn254';
}
export interface ChallengeRequest {
    /** Optional: pre-identified user public key commitment */
    commitment_hash?: string;
}
export interface ChallengeResponse {
    challenge_id: string;
    nonce: string;
    expires_at: number;
}
export interface ProofSubmission {
    challenge_id: string;
    proof: Groth16Proof;
    /** [nullifier_hash, commitment_root, nonce] — matches auth.circom's actual
     *  public signal order. Circom auto-publicizes circuit outputs regardless
     *  of the `public[]` declaration, so nullifier_hash + commitment_root
     *  (outputs) plus nonce (declared public input) are ALL public signals. */
    public_signals: [string, string, string];
}
export interface AuthTokens {
    access_token: string;
    refresh_token: string;
    token_type: 'Bearer';
    expires_in: number;
    session_id: string;
}
export interface JwtAccessPayload {
    sub: string;
    sid: string;
    risk: RiskLevel;
    iat: number;
    exp: number;
    type: 'access';
}
export interface JwtRefreshPayload {
    sub: string;
    sid: string;
    jti: string;
    iat: number;
    exp: number;
    type: 'refresh';
}
export interface StepUpEvent {
    event: 'STEP_UP_REQUIRED';
    session_id: string;
    risk_score: number;
    required_level: 'SOFT' | 'HARD';
    expires_at: number;
}
export interface ApiError {
    code: string;
    message: string;
    trace: string;
    timestamp: number;
}
//# sourceMappingURL=auth.types.d.ts.map