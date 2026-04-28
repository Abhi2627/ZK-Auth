/**
 * W3C Verifiable Credentials & DID Type Definitions
 *
 * Implements the core W3C VC Data Model 2.0 types with extensions for
 * ZK-Auth's Poseidon Merkle proof system.
 *
 * Specifications:
 *   - W3C VC Data Model 2.0: https://www.w3.org/TR/vc-data-model-2.0/
 *   - W3C DID Core 1.0:      https://www.w3.org/TR/did-core/
 *   - JSON-LD Context:       https://www.w3.org/ns/credentials/v2
 *
 * ZK-Auth extensions are namespaced under:
 *   https://zk-auth.io/vocab/v1
 *
 * ─── Three-actor model ────────────────────────────────────────────────────────
 *   Issuer  — Government / University API; creates and signs VCs
 *   Holder  — User wallet; stores VCs, generates ZK proofs, creates VPs
 *   Verifier — Bank / Service; requests specific claims, verifies ZK proofs
 *
 * ─── DID Method ───────────────────────────────────────────────────────────────
 *   did:web:  for issuers with known domain (e.g. did:web:gov.example.com)
 *   did:key:  for ephemeral/test DIDs derived from the public key bytes
 *
 * ─── ZKP embedding in VC ─────────────────────────────────────────────────────
 *   The standard VC credentialSubject carries the Merkle root (the public
 *   commitment to all attributes) but NOT the raw attribute values.
 *   The proof section carries the Groth16 cryptosuite proof when the VC is
 *   used inside a VP for selective disclosure.
 */

// ─── DID Document ─────────────────────────────────────────────────────────────

export interface DIDVerificationMethod {
  id:                 string;     // e.g. "did:web:gov.example.com#key-1"
  type:               'JsonWebKey2020' | 'Ed25519VerificationKey2020' | 'ZkAuthKey2024';
  controller:         string;     // DID that controls this key
  publicKeyJwk?:      JsonWebKey;
  publicKeyMultibase?: string;    // multibase-encoded public key
  /** ZK-Auth extension: Poseidon commitment for ZKP-based auth */
  poseidonCommitment?: string;    // hex field element
}

export interface DIDDocument {
  '@context':           string | string[];
  id:                   string;                        // the DID itself
  verificationMethod:   DIDVerificationMethod[];
  authentication?:      (string | DIDVerificationMethod)[];
  assertionMethod?:     (string | DIDVerificationMethod)[];
  keyAgreement?:        (string | DIDVerificationMethod)[];
  service?:             DIDService[];
  created?:             string;   // ISO 8601
  updated?:             string;   // ISO 8601
}

export interface DIDService {
  id:              string;
  type:            string;
  serviceEndpoint: string | string[] | Record<string, unknown>;
}

// ─── DID Resolution Result ────────────────────────────────────────────────────

export interface DIDResolutionResult {
  didDocument:    DIDDocument | null;
  didResolutionMetadata: {
    contentType?: string;
    error?:       'notFound' | 'invalidDid' | 'deactivated' | 'internalError';
    message?:     string;
    retrieved:    string;  // ISO 8601 timestamp
  };
  didDocumentMetadata: {
    created?:     string;
    updated?:     string;
    deactivated?: boolean;
    versionId?:   string;
  };
}

// ─── W3C VC Data Model 2.0 ───────────────────────────────────────────────────

/** Proof attached directly to a VC (e.g. issuer's signature or ZKP) */
export interface VCProof {
  type:               string;            // 'Groth16Proof2024' | 'DataIntegrityProof' | etc.
  created:            string;            // ISO 8601
  verificationMethod: string;            // DID URL pointing to the key
  proofPurpose:       'assertionMethod' | 'authentication' | 'keyAgreement';
  proofValue?:        string;            // multibase-encoded signature
  /** ZK-Auth extension: embedded Groth16 proof fields */
  zkProof?: {
    pi_a:            string[];
    pi_b:            string[][];
    pi_c:            string[];
    protocol:        'groth16';
    curve:           'bn254';
    publicSignals:   string[];
  };
  domain?:            string;
  challenge?:         string;
}

/** Credential status (optional revocation registry pointer) */
export interface CredentialStatus {
  id:   string;  // URL to the status list entry
  type: 'StatusList2021Entry' | 'ZkAuthRevocationEntry';
  statusListIndex?:    string;
  statusListCredential?: string;
}

/**
 * W3C Verifiable Credential (VC)
 *
 * credentialSubject contains the Merkle root commitment and attribute names
 * (but NEVER raw attribute values). The ZKP selective disclosure proof is
 * embedded in the `proof` section when the VC is wrapped in a VP.
 */
export interface VerifiableCredential {
  '@context':         string[];
  id:                 string;                           // URI (UUID urn or URL)
  type:               string[];                         // must include 'VerifiableCredential'
  issuer:             string | { id: string; name?: string };  // DID or DID+metadata
  issuanceDate:       string;                           // ISO 8601 — VC 1.1 compat
  validFrom?:         string;                           // ISO 8601 — VC 2.0
  validUntil?:        string;                           // ISO 8601 — VC 2.0
  credentialSubject:  VCCredentialSubject;
  credentialStatus?:  CredentialStatus;
  credentialSchema?:  { id: string; type: string };
  proof?:             VCProof | VCProof[];
  /** ZK-Auth extension: Merkle commitment metadata */
  zkCommitment?: {
    merkleRoot:      string;                            // hex Poseidon root
    attributeCount:  number;
    treeDepth:       number;
    hashFunction:    'poseidon';
    circuit:         string;                            // circuit_id reference
  };
}

/**
 * The subject of a VC.
 *
 * For ZK-Auth credentials: contains the holder's DID, the attribute NAMES
 * (schema), and the leaf hashes — but NEVER raw attribute values.
 */
export interface VCCredentialSubject {
  id?:             string;       // holder's DID
  [key: string]:   unknown;      // extensible attribute space
}

/**
 * W3C Verifiable Presentation (VP)
 *
 * Created by the Holder (wallet) to present one or more VCs to a Verifier.
 * The VP's proof contains the Groth16 selective disclosure proof showing
 * that a specific attribute satisfies the Verifier's predicate.
 */
export interface VerifiablePresentation {
  '@context':           string[];
  type:                 string[];       // must include 'VerifiablePresentation'
  id?:                  string;
  holder?:              string;         // holder's DID
  verifiableCredential: VerifiableCredential | VerifiableCredential[];
  proof?:               VCProof | VCProof[];
  /** ZK-Auth extension: selective disclosure proof payload */
  zkDisclosure?: {
    credentialId:       string;         // UUID of the source credential
    claimedPredicate:   string;         // e.g. "age >= 18"
    attributeName:      string;         // the attribute being proved
    leafIndex:          number;
    groth16Proof: {
      pi_a:             string[];
      pi_b:             string[][];
      pi_c:             string[];
      protocol:         'groth16';
      curve:            'bn254';
    };
    publicSignals:      string[];       // [root, threshold, leaf_index]
    verifierChallenge?: string;         // nonce from verifier's request
  };
}

// ─── Verifier Proof Request ───────────────────────────────────────────────────

/**
 * A request from a Verifier asking the Holder to prove a specific claim.
 * Transmitted as a QR code or deep-link payload.
 */
export interface ProofRequest {
  id:                 string;           // UUID — links request to response
  type:               'ZkAuthProofRequest';
  verifier: {
    did:              string;           // verifier's DID
    name:             string;           // human-readable name e.g. "Acme Bank"
    logoUrl?:         string;
    serviceEndpoint:  string;           // POST endpoint to submit VP
  };
  requestedClaims: RequestedClaim[];
  challenge:          string;           // 32-byte hex nonce — prevents replay
  expiresAt:          number;           // Unix epoch ms — request TTL
  /** Human-readable reason shown in the consent modal */
  purpose:            string;           // e.g. "Age verification for account opening"
}

export interface RequestedClaim {
  attributeName:      string;           // e.g. "age"
  credentialType:     string;           // e.g. "GovernmentID"
  predicate:          'GTE' | 'LTE' | 'EQ';
  threshold:          number;
  /** Human-readable description for the consent modal */
  displayLabel:       string;           // e.g. "Proving age ≥ 18"
  /** What the user is NOT revealing */
  privacyStatement:   string;           // e.g. "Your actual date of birth is not shared"
}
