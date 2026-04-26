/**
 * Credential Routes — /api/v1/credential
 * Phase 3 will implement: issuance, selective disclosure verification, revocation.
 */
import { Router } from 'express';

export const credentialRouter = Router();

// POST /api/v1/credential/issue
credentialRouter.post('/issue', (_req, res) => {
  res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Phase 3 target' });
});

// POST /api/v1/credential/verify-claim
credentialRouter.post('/verify-claim', (_req, res) => {
  res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Phase 3 target' });
});

// POST /api/v1/credential/revoke
credentialRouter.post('/revoke', (_req, res) => {
  res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Phase 3 target' });
});

// GET /api/v1/credential/:credentialId
credentialRouter.get('/:credentialId', (_req, res) => {
  res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Phase 3 target' });
});
