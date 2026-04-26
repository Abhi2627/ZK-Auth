// ─────────────────────────────────────────────────────────────────────────────
// ZK-Auth Shared Credential Types
// ─────────────────────────────────────────────────────────────────────────────

export type CredentialStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export type ClaimOperator = 'EQ' | 'GTE' | 'LTE' | 'IN';

// ─── Credential Issuance ─────────────────────────────────────────────────────

export interface CredentialAttributes {
  [attributeName: string]: string | number | boolean;
}

export interface IssueCredentialRequest {
  user_id: string;
  credential_type: string;   // e.g. 'EMPLOYEE_CLEARANCE'
  attributes: CredentialAttributes;
  expires_at?: number;       // Optional Unix epoch ms
}

export interface IssueCredentialResponse {
  credential_id: string;
  merkle_root: string;       // hex-encoded Merkle root commitment R
  issued_at: number;
  expires_at?: number;
}

// ─── Selective Disclosure ────────────────────────────────────────────────────

export interface ClaimPredicate {
  attribute: string;         // e.g. 'clearance_level'
  operator: ClaimOperator;
  value: string | number;
}

export interface DisclosureProofRequest {
  user_id: string;
  credential_type: string;
  predicate: ClaimPredicate;
  verifier_id: string;       // identifier of the requesting verifier
}

export interface DisclosureProofResponse {
  credential_id: string;
  merkle_root: string;
  proof_json: string;        // JSON-serialized Merkle path + Groth16 proof π
  public_signals: string[];  // [root, predicate_hash, nullifier_for_verifier]
  predicate: ClaimPredicate;
}

export interface DisclosureVerifyRequest {
  merkle_root: string;
  proof_json: string;
  public_signals: string[];
  predicate: ClaimPredicate;
}

export interface DisclosureVerifyResponse {
  valid: boolean;
  verified_at: number;
}

// ─── Revocation ──────────────────────────────────────────────────────────────

export interface RevokeCredentialRequest {
  credential_id: string;
  reason: string;
}
