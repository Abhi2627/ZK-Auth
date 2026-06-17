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
import { getVerifyDoc } from '../controllers/ecosystem/verifyDoc.controller.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.middleware.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { registerPendingVerifierRequest } from '../services/verifyRequest/notifier.service.js';

// Demo verifier API keys tied to DIDs
// In production these would be in a database with hashed keys
const DEMO_VERIFIER_KEYS: Record<string, { did: string; org_name: string }> = {
  'demo_verifier_acme_key_32chars_minimum':  { did: 'did:web:bank.zk-auth.io',    org_name: 'Acme Corp HR Portal' },
  'demo_verifier_sbi_key_32chars_minimum_x': { did: 'did:web:sbi.zk-auth.io',     org_name: 'State Bank of India' },
  'demo_verifier_tech_key_32chars_minimum_': { did: 'did:web:techcorp.zk-auth.io', org_name: 'TechCorp Engineering' },
};

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
verifierRouter.get('/verify-doc/:id',       getVerifyDoc);  // QR scan lookup

// POST /api/verifier/verify-apikey  -- validate verifier API key, return DID + org
verifierRouter.post('/verify-apikey', async (req, res, next) => {
  try {
    const { api_key } = req.body as { api_key?: string };
    if (!api_key || typeof api_key !== 'string') {
      res.status(400).json({ message: 'api_key is required' });
      return;
    }
    const verifier = DEMO_VERIFIER_KEYS[api_key];
    if (!verifier) {
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 200));
      res.status(401).json({ message: 'Invalid API key' });
      return;
    }
    res.status(200).json({ valid: true, verifier_did: verifier.did, org_name: verifier.org_name });
  } catch (err) { next(err); }
});

// POST /api/verifier/watch/:requestId
// Verifier registers their WS session_id to receive live push when holder responds.
// Called by verifier portal immediately after generating a QR proof request.
verifierRouter.post('/watch/:requestId', authMiddleware, async (req, res, next) => {
  try {
    const { requestId } = req.params as { requestId: string };
    const { session_id, ttl_ms } = req.body as { session_id?: string; ttl_ms?: number };

    if (!session_id) {
      res.status(400).json({ message: 'session_id is required' });
      return;
    }

    registerPendingVerifierRequest(
      requestId,
      session_id,
      ttl_ms ?? 600_000,
    );

    res.status(200).json({
      watching:   true,
      request_id: requestId,
      message:    'Registered for live push. You will receive VERIFY_REQUEST_APPROVED or VERIFY_REQUEST_REJECTED via WebSocket.',
    });
  } catch (err) { next(err); }
});
