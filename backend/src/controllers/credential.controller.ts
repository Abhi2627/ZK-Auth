/**
 * Credential Controller
 *
 * Implements the selective disclosure credential endpoints:
 *
 *   POST /credential/issue        — Issue a new credential (Issuer role required)
 *   POST /credential/verify-claim — Verify a selective disclosure proof (public)
 *   POST /credential/revoke       — Revoke a credential (Issuer role required)
 *   GET  /credential/:id          — Fetch credential metadata (owner only)
 *
 * ─── Role model ──────────────────────────────────────────────────────────────
 *   ISSUER role:  checked via JWT claim (jwtPayload.role === 'issuer').
 *                 Only issuers can call /issue and /revoke.
 *                 In production this is a separate service account; the role
 *                 is encoded in the JWT at issuance time by the admin flow
 *                 (Phase 5 — admin issuance API).
 *                 For Phase 4 we enforce it with a middleware guard.
 *
 *   /verify-claim: intentionally does NOT require a JWT. Verifiers are
 *                  third-party systems that only need to submit the proof
 *                  and receive a boolean result. They never see the user's
 *                  credentials or session tokens.
 */

import type { Request, Response, NextFunction } from 'express';
import { credentialService } from '../services/credential/credential.service.js';
import { disclosureService } from '../services/credential/disclosure.service.js';
import {
  parseBody,
  issueCredentialSchema,
  verifyClaimSchema,
  revokeCredentialSchema,
} from './credential.schemas.js';
import { logger } from '../utils/logger.js';
import { AppError, ErrorCode, ForbiddenError } from '../utils/errors.js';
import type { AuthenticatedSession } from '../middleware/auth.middleware.js';

// ─── POST /credential/issue ───────────────────────────────────────────────────

export async function postIssueCredential(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Issuer-role guard (enforced in route via requireIssuerRole middleware)
    const body = parseBody(issueCredentialSchema, req.body);

    const expiresAt = body.expires_at ? new Date(body.expires_at) : undefined;

    if (expiresAt && expiresAt <= new Date()) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'expires_at must be a future date',
        400,
      );
    }

    const result = await credentialService.issueCredential(
      body.user_id,
      body.credential_type_id,
      body.attributes,
      expiresAt,
    );

    logger.info(
      { credentialId: result.credentialId, userId: body.user_id },
      'Credential issued via API',
    );

    // Return salts to the issuer/client — these are needed for proof generation.
    // SECURITY: Salts are transmitted over TLS and must be stored by the client.
    // They are NOT retrievable from the server after this response.
    res.status(201).json({
      credential_id: result.credentialId,
      merkle_root: result.merkleRoot,
      issued_at: result.issuedAt.toISOString(),
      // Salts delivered once — client must persist these securely
      salts: result.salts,
      leaf_hashes: result.leafHashes,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /credential/verify-claim ───────────────────────────────────────────

export async function postVerifyClaim(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseBody(verifyClaimSchema, req.body);

    const result = await disclosureService.verifyClaim({
      proof: body.proof,
      publicSignals: body.public_signals,
      credentialId: body.credential_id,
      claimedPredicate: body.claimed_predicate,
      verifierId: body.verifier_id,
    });

    // Return only the boolean result — NO credential metadata, NO signals
    // The verifier learns only: "the claim holds for this credential".
    res.status(200).json({
      valid: result.valid,
      claimed_predicate: result.claimedPredicate,
      verified_at: result.verifiedAt.toISOString(),
    });
  } catch (err) {
    // For invalid proofs we still return 200 with valid:false to prevent
    // timing-based enumeration of credential existence.
    // Only structural/auth errors return 4xx.
    if (
      err instanceof AppError &&
      err.code === ErrorCode.INVALID_CLAIM_PROOF
    ) {
      res.status(200).json({
        valid: false,
        claimed_predicate: req.body?.claimed_predicate ?? '',
        verified_at: new Date().toISOString(),
        reason: 'Proof verification failed',
      });
      return;
    }
    next(err);
  }
}

// ─── POST /credential/revoke ─────────────────────────────────────────────────

export async function postRevokeCredential(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;
    const body = parseBody(revokeCredentialSchema, req.body);

    await credentialService.revokeCredential(
      body.credential_id,
      session.userId,
      body.reason,
    );

    res.status(200).json({ message: 'Credential revoked successfully' });
  } catch (err) {
    next(err);
  }
}

// ─── GET /credential/:credentialId ───────────────────────────────────────────

export async function getCredential(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;
    const { credentialId } = req.params as { credentialId: string };

    if (!credentialId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'credentialId is required', 400);
    }

    const credential = await credentialService.getCredential(
      credentialId,
      session.userId,
    );

    res.status(200).json({
      credential_id: credential.id,
      credential_type: credential.credentialType.name,
      circuit_id: credential.credentialType.circuitId,
      merkle_root: credential.merkleRoot,
      attribute_count: credential.attributeCount,
      status: credential.status,
      issued_at: credential.issuedAt.toISOString(),
      expires_at: credential.expiresAt?.toISOString() ?? null,
      // Return attribute names and leaf indices — NOT hashes, NOT salts
      attributes: credential.leaves.map((l) => ({
        name: l.attributeName,
        leaf_index: l.leafIndex,
      })),
    });
  } catch (err) {
    next(err);
  }
}
