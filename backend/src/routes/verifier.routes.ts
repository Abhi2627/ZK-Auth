/**
 * Verifier Routes — /api/verifier
 *
 * These routes simulate a Bank / Service verifier node.
 * Separate prefix from /api/v1/* to reflect actor separation.
 *
 *   POST /api/verifier/request-proof  — Generate a ProofRequest (QR payload)
 *   POST /api/verifier/verify         — Accept a VP, resolve DID, verify ZKP
 *   GET  /api/verifier/did-document   — Expose the verifier's DID document
 */

import { Router } from 'express';
import {
  postRequestProof,
  postVerifyPresentation,
  getVerifierDIDDocument,
} from '../controllers/ecosystem/verifier.controller.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.middleware.js';

export const verifierRouter = Router();

const requestProofRateLimit = rateLimitMiddleware({
  endpoint:      'verifier_request_proof',
  limit:         30,
  windowSeconds: 60,
});

const verifyVPRateLimit = rateLimitMiddleware({
  endpoint:      'verifier_verify_vp',
  limit:         30,
  windowSeconds: 60,
});

verifierRouter.post('/request-proof',       requestProofRateLimit, postRequestProof);
verifierRouter.post('/verify',              verifyVPRateLimit,     postVerifyPresentation);
verifierRouter.get('/did-document',         getVerifierDIDDocument);
verifierRouter.get('/.well-known/did.json', getVerifierDIDDocument);
