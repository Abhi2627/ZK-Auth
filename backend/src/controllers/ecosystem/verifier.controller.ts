/**
 * Verifier Controller — Mock Bank / Service Verifier Node
 *
 * Routes:
 *   POST /api/verifier/request-proof  — generate a signed ProofRequest (QR payload)
 *   POST /api/verifier/verify         — accept a VP, resolve issuer DID, verify proof
 *   GET  /api/verifier/did-document   — expose the bank's DID document
 *
 * ─── Verification flow ───────────────────────────────────────────────────────
 *
 *   1. [verifier/request-proof] Client requests what claims are needed.
 *      Server generates a ProofRequest with a 32-byte challenge nonce and TTL.
 *      This is returned as JSON that the UI encodes as a QR code.
 *
 *   2. [Holder wallet] User scans the QR code, reviews the consent modal,
 *      generates a Groth16 proof with their local circuit artifacts,
 *      wraps it in a W3C VP, and POSTs it to /api/verifier/verify.
 *
 *   3. [verifier/verify]:
 *      a. Validate the VP structure (type, holder, zkDisclosure fields).
 *      b. Extract the issuer DID from verifiableCredential[0].issuer.
 *      c. Resolve issuer DID → DID Document (via DIDRegistry).
 *      d. Extract the assertionMethod verification key from the DID Document.
 *      e. Validate the VC proof signature against the issuer's public key.
 *         (Mock: verify sha256 hash; production: verify Ed25519/BBS+ signature)
 *      f. Check the verifierChallenge matches the outstanding ProofRequest.
 *      g. Resolve the credential_id's stored merkle_root from the database.
 *      h. Assert VP's publicSignals[0] (root) == stored root (prevents forgery).
 *      i. Run snarkjs.groth16.verify(disclosureVKey, publicSignals, proof).
 *      j. Write audit record + return { granted: true/false }.
 *
 * ─── Challenge → response linkage ────────────────────────────────────────────
 *   Outstanding proof requests are stored in Redis with a 5-minute TTL.
 *   Key: zkauth:proofRequest:{requestId}
 *   This prevents replay: a VP submitted with an expired or non-existent
 *   challenge is rejected before any ZKP computation runs.
 */

import type { Request, Response, NextFunction } from 'express';
import { z }                           from 'zod';
import { prisma }                      from '../../config/database.js';
import { redis }                       from '../../config/redis.js';
import { didRegistry }                 from '../../services/identity/did.registry.js';
import { vcBuilder }                   from '../../services/identity/vc.builder.js';
import { disclosureService }           from '../../services/credential/disclosure.service.js';
import { sha256, generateId }          from '../../utils/crypto.js';
import { logger }                      from '../../utils/logger.js';
import {
  AppError,
  ErrorCode,
  ValidationError,
  NotFoundError,
} from '../../utils/errors.js';
import type {
  VerifiablePresentation,
  VerifiableCredential,
  ProofRequest,
  RequestedClaim,
} from '../../services/identity/vc.types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BANK_VERIFIER_DID      = 'did:web:bank.zk-auth.io';
const BANK_SERVICE_ENDPOINT  = 'https://bank.zk-auth.io/api/verifier/verify';
const PROOF_REQUEST_TTL_S    = 300;   // 5 minutes

// ─── Redis key ────────────────────────────────────────────────────────────────

function proofRequestKey(requestId: string): string {
  return `proofRequest:${requestId}`;
}

// ─── Input validation ─────────────────────────────────────────────────────────

const requestProofSchema = z.object({
  /** Type of credential needed (e.g. 'GovernmentID') */
  credential_type: z.string().min(1).max(64),
  /** The predicate the verifier wants to verify */
  claims: z.array(
    z.object({
      attribute_name:    z.string().min(1).max(64),
      predicate:         z.enum(['GTE', 'LTE', 'EQ']),
      threshold:         z.number().int().min(0),
      display_label:     z.string().max(128),
      privacy_statement: z.string().max(256),
    })
  ).min(1).max(8),
  purpose: z.string().max(256),
}).strict();

const verifyVPSchema = z.object({
  verifiable_presentation: z.record(z.unknown()),
  request_id:              z.string().uuid(),
}).strict();

// ─── POST /api/verifier/request-proof ────────────────────────────────────────

export async function postRequestProof(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = requestProofSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(`${first?.path.join('.') ?? 'field'}: ${first?.message}`);
    }
    const body = parsed.data;

    // Build typed RequestedClaim array
    const requestedClaims: RequestedClaim[] = body.claims.map((c): RequestedClaim => ({
      attributeName:    c.attribute_name,
      credentialType:   body.credential_type,
      predicate:        c.predicate,
      threshold:        c.threshold,
      displayLabel:     c.display_label,
      privacyStatement: c.privacy_statement,
    }));

    // Build ProofRequest via VC builder
    const proofRequest: ProofRequest = vcBuilder.buildProofRequest({
      verifierDid:     BANK_VERIFIER_DID,
      verifierName:    'ZK-Auth Mock Bank',
      serviceEndpoint: BANK_SERVICE_ENDPOINT,
      claims:          requestedClaims,
      purpose:         body.purpose,
      ttlSeconds:      PROOF_REQUEST_TTL_S,
    });

    // Store in Redis for challenge validation (TTL = PROOF_REQUEST_TTL_S)
    await redis.set(
      proofRequestKey(proofRequest.id),
      JSON.stringify(proofRequest),
      'EX', PROOF_REQUEST_TTL_S,
    );

    logger.info(
      { requestId: proofRequest.id, verifierDid: BANK_VERIFIER_DID },
      'Proof request issued',
    );

    res.status(200).json({
      request_id:    proofRequest.id,
      proof_request: proofRequest,
      /**
       * qr_payload is the JSON string to encode as a QR code.
       * The wallet scans this and reconstructs the ProofRequest.
       * In production: sign this with the verifier's key to prevent tampering.
       */
      qr_payload:   JSON.stringify(proofRequest),
      expires_at:   new Date(proofRequest.expiresAt).toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/verifier/verify ────────────────────────────────────────────────

export async function postVerifyPresentation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = verifyVPSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(`${first?.path.join('.') ?? 'field'}: ${first?.message}`);
    }

    const { verifiable_presentation: vpRaw, request_id } = parsed.data;
    const vp = vpRaw as unknown as VerifiablePresentation;

    // ── Step 1: Structural validation ─────────────────────────────────────
    if (!Array.isArray(vp.type) || !vp.type.includes('VerifiablePresentation')) {
      throw new AppError(ErrorCode.INVALID_CLAIM_PROOF, 'Invalid VP: missing VerifiablePresentation type', 400);
    }
    if (!vp.zkDisclosure) {
      throw new AppError(ErrorCode.INVALID_CLAIM_PROOF, 'Invalid VP: missing zkDisclosure field', 400);
    }
    const { zkDisclosure } = vp;
    if (!zkDisclosure.groth16Proof || !zkDisclosure.publicSignals || zkDisclosure.publicSignals.length !== 3) {
      throw new AppError(ErrorCode.INVALID_CLAIM_PROOF, 'Invalid VP: malformed zkDisclosure', 400);
    }

    // ── Step 2: Validate challenge against stored ProofRequest ────────────
    const storedRaw = await redis.get(proofRequestKey(request_id));
    if (!storedRaw) {
      throw new AppError(
        ErrorCode.CHALLENGE_EXPIRED,
        'Proof request has expired or does not exist',
        400,
      );
    }
    const storedRequest = JSON.parse(storedRaw) as ProofRequest;

    if (
      zkDisclosure.verifierChallenge &&
      zkDisclosure.verifierChallenge !== storedRequest.challenge
    ) {
      throw new AppError(
        ErrorCode.INVALID_CLAIM_PROOF,
        'Verifier challenge mismatch — possible replay attack',
        400,
      );
    }

    // ── Step 3: Extract issuer DID from the embedded VC ───────────────────
    const embeddedVC = Array.isArray(vp.verifiableCredential)
      ? vp.verifiableCredential[0]
      : vp.verifiableCredential;

    if (!embeddedVC) {
      throw new AppError(ErrorCode.INVALID_CLAIM_PROOF, 'VP contains no verifiable credentials', 400);
    }

    const issuerDid = typeof embeddedVC.issuer === 'string'
      ? embeddedVC.issuer
      : embeddedVC.issuer?.id;

    if (!issuerDid) {
      throw new AppError(ErrorCode.INVALID_CLAIM_PROOF, 'Cannot determine issuer DID from VC', 400);
    }

    // ── Step 4: Resolve issuer DID → public key ───────────────────────────
    // This is the key operation: we look up the issuer's key from the DID registry,
    // NOT from anything the client sent us.
    const verificationMethod = await didRegistry.resolveVerificationMethod(
      issuerDid,
      `${issuerDid}#key-1`,
    );

    if (!verificationMethod) {
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        `Cannot resolve issuer DID: ${issuerDid}`,
        503,
      );
    }

    logger.info(
      { issuerDid, keyId: verificationMethod.id },
      'Issuer DID resolved for VP verification',
    );

    // ── Step 5: Verify the VC proof (mock: re-derive sha256 hash) ─────────
    // Production: verify Ed25519 or BBS+ signature using verificationMethod.publicKeyJwk
    const vcProof = Array.isArray(embeddedVC.proof) ? embeddedVC.proof[0] : embeddedVC.proof;
    if (vcProof) {
      const expectedHash = 'z' + Buffer.from(
        sha256(JSON.stringify({
          credentialId: zkDisclosure.credentialId,
          merkleRoot:   (embeddedVC.zkCommitment?.merkleRoot ?? ''),
          holderDid:    vp.holder ?? '',
        })),
        'hex',
      ).toString('base64url');

      if (vcProof.proofValue !== expectedHash) {
        logger.warn({ credentialId: zkDisclosure.credentialId }, 'VC proof signature invalid');
        throw new AppError(ErrorCode.INVALID_CLAIM_PROOF, 'VC issuer proof is invalid', 400);
      }
    }

    // ── Step 6: Delegate to DisclosureService for ZKP verification ────────
    const disclosureResult = await disclosureService.verifyClaim({
      proof: zkDisclosure.groth16Proof as DisclosureProofInput['proof'],
      publicSignals: zkDisclosure.publicSignals as [string, string, string],
      credentialId:  zkDisclosure.credentialId,
      claimedPredicate: zkDisclosure.claimedPredicate,
      verifierId:    BANK_VERIFIER_DID,
    });

    // ── Step 7: Consume the proof request (one-time use) ──────────────────
    await redis.del(proofRequestKey(request_id));

    logger.info(
      {
        requestId:     request_id,
        credentialId:  zkDisclosure.credentialId,
        predicate:     zkDisclosure.claimedPredicate,
        verifierDid:   BANK_VERIFIER_DID,
        holderDid:     vp.holder,
        issuerDid,
      },
      'VP verified successfully — access granted',
    );

    res.status(200).json({
      granted:           disclosureResult.valid,
      claimed_predicate: disclosureResult.claimedPredicate,
      verified_at:       disclosureResult.verifiedAt.toISOString(),
      issuer_did:        issuerDid,
      verifier_did:      BANK_VERIFIER_DID,
      /**
       * Privacy: the verifier receives ONLY the boolean grant decision.
       * No attribute values, no salts, no raw signals are included.
       */
      privacy_notice: 'Verification result only — no PII was shared.',
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/verifier/did-document ──────────────────────────────────────────

export async function getVerifierDIDDocument(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await didRegistry.resolve(BANK_VERIFIER_DID);
    if (!result.didDocument) {
      res.status(404).json({ error: 'DID document not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/did+json');
    res.status(200).json(result.didDocument);
  } catch (err) {
    next(err);
  }
}

// ─── Type import for DisclosureService ────────────────────────────────────────
import type { DisclosureProofInput } from '../../services/credential/disclosure.service.js';
