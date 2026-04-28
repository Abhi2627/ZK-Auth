/**
 * VC Builder Service — W3C Verifiable Credential / Presentation construction
 *
 * Wraps ZK-Auth's internal credential representation in W3C VC Data Model 2.0
 * JSON-LD envelopes. This layer provides the "connective tissue" between
 * our cryptographic primitives (Poseidon Merkle trees, Groth16 proofs) and
 * the interoperable W3C standards layer.
 *
 * ─── VC structure for ZK-Auth credentials ────────────────────────────────────
 *
 *   {
 *     "@context": ["https://www.w3.org/ns/credentials/v2", "https://zk-auth.io/vocab/v1"],
 *     "type": ["VerifiableCredential", "ZkAuthMerkleCredential"],
 *     "issuer": "did:web:gov.zk-auth.io",
 *     "credentialSubject": {
 *       "id": "did:key:z...",           ← holder's DID
 *       "credentialType": "GovernmentID",
 *       "attributeNames": ["age", "nationality", "name"],  ← schema only, no values
 *       "leafHashes": { "age": "0x...", ... }              ← Poseidon commitments
 *     },
 *     "zkCommitment": {
 *       "merkleRoot": "0x...",
 *       "treeDepth": 8,
 *       "hashFunction": "poseidon",
 *       "circuit": "merkle_disclosure_v1"
 *     },
 *     "proof": { ... }                  ← issuer's assertion proof (mock ECDSA)
 *   }
 *
 * ─── VP structure for selective disclosure ────────────────────────────────────
 *
 *   {
 *     "@context": [...],
 *     "type": ["VerifiablePresentation", "ZkAuthSelectiveDisclosure"],
 *     "holder": "did:key:z...",
 *     "verifiableCredential": [ ... VC ... ],
 *     "zkDisclosure": {
 *       "claimedPredicate": "age >= 18",
 *       "groth16Proof": { pi_a, pi_b, pi_c, protocol, curve },
 *       "publicSignals": ["<root>", "<threshold>", "<leaf_index>"],
 *       "verifierChallenge": "a3f1..."   ← from the ProofRequest
 *     }
 *   }
 */

import { generateId }           from '../../utils/crypto.js';
import { sha256 }               from '../../utils/crypto.js';
import {
  VC_CONTEXT_V2,
  ZKAUTH_VOCAB,
  DIDRegistryService,
} from './did.registry.js';
import type {
  VerifiableCredential,
  VerifiablePresentation,
  VCProof,
  VCCredentialSubject,
  ProofRequest,
  RequestedClaim,
} from './vc.types.js';

// ─── Builder ──────────────────────────────────────────────────────────────────

export class VCBuilder {

  // ─── Build a VC from a credential issuance ───────────────────────────────

  /**
   * Wrap a ZK-Auth internal credential as a W3C VC.
   *
   * @param params.credentialId     — Internal UUID
   * @param params.issuerDid        — Issuer's DID (e.g. 'did:web:gov.zk-auth.io')
   * @param params.holderDid        — Holder's DID (e.g. 'did:key:z...')
   * @param params.credentialType   — Schema name (e.g. 'GovernmentID')
   * @param params.attributeNames   — Ordered attribute schema keys (no values)
   * @param params.leafHashes       — Poseidon(value, salt) per attribute (hex)
   * @param params.merkleRoot       — Poseidon Merkle root (hex)
   * @param params.circuitId        — The verification circuit identifier
   * @param params.issuedAt         — Issuance timestamp
   * @param params.expiresAt        — Optional expiry
   */
  buildVC(params: {
    credentialId:    string;
    issuerDid:       string;
    holderDid:       string;
    credentialType:  string;
    attributeNames:  string[];
    leafHashes:      Record<string, string>;
    salts:           Record<string, string>;
    merkleRoot:      string;
    circuitId:       string;
    issuedAt:        Date;
    expiresAt?:      Date;
  }): VerifiableCredential {
    const {
      credentialId, issuerDid, holderDid, credentialType,
      attributeNames, leafHashes, salts, merkleRoot, circuitId,
      issuedAt, expiresAt,
    } = params;

    const credentialSubject: VCCredentialSubject = {
      id:             holderDid,
      credentialType,
      attributeNames,    // schema — no raw values
      leafHashes,        // Poseidon commitments — unlinkable without salt
      // salts are included in the VC delivered to the holder's wallet ONLY.
      // The issuer and verifier never receive the salts.
      salts,
    };

    // Mock issuer proof — in production this would be a real Ed25519 or BBS+ signature
    const proof: VCProof = {
      type:               'DataIntegrityProof',
      created:            issuedAt.toISOString(),
      verificationMethod: `${issuerDid}#key-1`,
      proofPurpose:       'assertionMethod',
      // In production: proofValue = base64url(Ed25519Sign(canonicalized_vc))
      // For Phase 9 mock: sha256 of credential content
      proofValue:         'z' + Buffer.from(
        sha256(JSON.stringify({ credentialId, merkleRoot, holderDid })),
        'hex',
      ).toString('base64url'),
    };

    const vc: VerifiableCredential = {
      '@context': [VC_CONTEXT_V2, ZKAUTH_VOCAB],
      id:         `urn:uuid:${credentialId}`,
      type:       ['VerifiableCredential', 'ZkAuthMerkleCredential', credentialType],
      issuer: {
        id:   issuerDid,
        name: this._issuerNameFromDid(issuerDid),
      },
      issuanceDate: issuedAt.toISOString(),
      validFrom:    issuedAt.toISOString(),
      ...(expiresAt ? { validUntil: expiresAt.toISOString() } : {}),
      credentialSubject,
      zkCommitment: {
        merkleRoot,
        attributeCount: attributeNames.length,
        treeDepth:      8,
        hashFunction:   'poseidon',
        circuit:        circuitId,
      },
      credentialSchema: {
        id:   `${ZKAUTH_VOCAB}/schemas/${credentialType}`,
        type: 'ZkAuthMerkleSchema',
      },
      proof,
    };

    return vc;
  }

  // ─── Build a VP for selective disclosure ─────────────────────────────────

  /**
   * Wrap a VC and a Groth16 disclosure proof in a W3C VP.
   * The VP is what the Holder sends to the Verifier.
   */
  buildVP(params: {
    holderDid:          string;
    vc:                 VerifiableCredential;
    credentialId:       string;
    attributeName:      string;
    leafIndex:          number;
    claimedPredicate:   string;
    groth16Proof:       {
      pi_a: string[];
      pi_b: string[][];
      pi_c: string[];
      protocol: 'groth16';
      curve:    'bn254';
    };
    publicSignals:      string[];    // [root_decimal, threshold_decimal, leaf_index_decimal]
    verifierChallenge?: string;
  }): VerifiablePresentation {
    const {
      holderDid, vc, credentialId, attributeName, leafIndex,
      claimedPredicate, groth16Proof, publicSignals, verifierChallenge,
    } = params;

    // Strip salts and leaf hashes from the VC before sending to verifier
    // (the VP's credentialSubject should not expose the holder's internal data)
    const sanitisedVC = this._sanitiseVCForVerifier(vc);

    const vp: VerifiablePresentation = {
      '@context': [VC_CONTEXT_V2, ZKAUTH_VOCAB],
      type:       ['VerifiablePresentation', 'ZkAuthSelectiveDisclosure'],
      id:         `urn:uuid:${generateId()}`,
      holder:     holderDid,
      verifiableCredential: sanitisedVC,
      zkDisclosure: {
        credentialId,
        claimedPredicate,
        attributeName,
        leafIndex,
        groth16Proof,
        publicSignals,
        ...(verifierChallenge ? { verifierChallenge } : {}),
      },
    };

    return vp;
  }

  // ─── Build a Proof Request (Verifier → Holder) ───────────────────────────

  buildProofRequest(params: {
    verifierDid:     string;
    verifierName:    string;
    verifierLogoUrl?: string;
    serviceEndpoint: string;
    claims:          RequestedClaim[];
    purpose:         string;
    ttlSeconds?:     number;
  }): ProofRequest {
    const {
      verifierDid, verifierName, verifierLogoUrl, serviceEndpoint,
      claims, purpose, ttlSeconds = 300,
    } = params;

    return {
      id:   generateId(),
      type: 'ZkAuthProofRequest',
      verifier: {
        did:             verifierDid,
        name:            verifierName,
        ...(verifierLogoUrl ? { logoUrl: verifierLogoUrl } : {}),
        serviceEndpoint,
      },
      requestedClaims: claims,
      challenge:       require('crypto').randomBytes(32).toString('hex') as string,
      expiresAt:       Date.now() + ttlSeconds * 1_000,
      purpose,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _sanitiseVCForVerifier(vc: VerifiableCredential): VerifiableCredential {
    // Deep clone and strip sensitive fields
    const clone = JSON.parse(JSON.stringify(vc)) as VerifiableCredential;
    const subject = clone.credentialSubject as Record<string, unknown>;

    // Remove salts — verifier must NEVER see salts
    delete subject['salts'];
    // Keep leafHashes (public commitments) and attributeNames (schema)

    return clone;
  }

  private _issuerNameFromDid(did: string): string {
    const map: Record<string, string> = {
      'did:web:gov.zk-auth.io': 'ZK-Auth Mock Government',
      'did:web:uni.zk-auth.io': 'ZK-Auth Mock University',
      'did:web:bank.zk-auth.io': 'ZK-Auth Mock Bank',
    };
    return map[did] ?? did;
  }
}

export const vcBuilder = new VCBuilder();
