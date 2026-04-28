/**
 * W3C VC/VP/DID types — client-side copy for the web wallet.
 * Mirrors backend/src/services/identity/vc.types.ts
 * (kept separate to avoid server-side imports in browser bundles)
 */

export interface VerifiableCredential {
  '@context':        string[];
  id:                string;
  type:              string[];
  issuer:            string | { id: string; name?: string };
  issuanceDate:      string;
  validFrom?:        string;
  validUntil?:       string;
  credentialSubject: Record<string, unknown>;
  credentialStatus?: unknown;
  credentialSchema?: { id: string; type: string };
  proof?:            VCProof | VCProof[];
  zkCommitment?: {
    merkleRoot:      string;
    attributeCount:  number;
    treeDepth:       number;
    hashFunction:    'poseidon';
    circuit:         string;
  };
}

export interface VCProof {
  type:               string;
  created:            string;
  verificationMethod: string;
  proofPurpose:       string;
  proofValue?:        string;
  zkProof?: {
    pi_a:          string[];
    pi_b:          string[][];
    pi_c:          string[];
    protocol:      'groth16';
    curve:         'bn254';
    publicSignals: string[];
  };
}

export interface VerifiablePresentation {
  '@context':           string[];
  type:                 string[];
  id?:                  string;
  holder?:              string;
  verifiableCredential: VerifiableCredential | VerifiableCredential[];
  proof?:               VCProof | VCProof[];
  zkDisclosure?: {
    credentialId:     string;
    claimedPredicate: string;
    attributeName:    string;
    leafIndex:        number;
    groth16Proof: {
      pi_a:    string[];
      pi_b:    string[][];
      pi_c:    string[];
      protocol: 'groth16';
      curve:    'bn254';
    };
    publicSignals:     string[];
    verifierChallenge?: string;
  };
}

export interface ProofRequest {
  id:   string;
  type: 'ZkAuthProofRequest';
  verifier: {
    did:             string;
    name:            string;
    logoUrl?:        string;
    serviceEndpoint: string;
  };
  requestedClaims:  RequestedClaim[];
  challenge:        string;
  expiresAt:        number;
  purpose:          string;
}

export interface RequestedClaim {
  attributeName:    string;
  credentialType:   string;
  predicate:        'GTE' | 'LTE' | 'EQ';
  threshold:        number;
  displayLabel:     string;
  privacyStatement: string;
}
