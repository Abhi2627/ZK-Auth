export type CredentialStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';
export type ClaimOperator = 'EQ' | 'GTE' | 'LTE' | 'IN';
export interface CredentialAttributes {
    [attributeName: string]: string | number | boolean;
}
export interface IssueCredentialRequest {
    user_id: string;
    credential_type: string;
    attributes: CredentialAttributes;
    expires_at?: number;
}
export interface IssueCredentialResponse {
    credential_id: string;
    merkle_root: string;
    issued_at: number;
    expires_at?: number;
}
export interface ClaimPredicate {
    attribute: string;
    operator: ClaimOperator;
    value: string | number;
}
export interface DisclosureProofRequest {
    user_id: string;
    credential_type: string;
    predicate: ClaimPredicate;
    verifier_id: string;
}
export interface DisclosureProofResponse {
    credential_id: string;
    merkle_root: string;
    proof_json: string;
    public_signals: string[];
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
export interface RevokeCredentialRequest {
    credential_id: string;
    reason: string;
}
//# sourceMappingURL=credential.types.d.ts.map