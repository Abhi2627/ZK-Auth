import { Router } from 'express';
import {
  postIssueId,
  getIssuerDIDDocument,
} from '../controllers/ecosystem/issuer.controller.js';
import { rateLimitMiddleware }     from '../middleware/rateLimit.middleware.js';
import { idempotencyMiddleware }   from '../middleware/idempotency.middleware.js';

export const issuerRouter = Router();

const issueIdRateLimit = rateLimitMiddleware({
  endpoint: 'issuer_issue_id', limit: 10, windowSeconds: 60,
});

issuerRouter.post('/issue-id', issueIdRateLimit, idempotencyMiddleware(), postIssueId);
issuerRouter.get('/did-document',         getIssuerDIDDocument);
issuerRouter.get('/.well-known/did.json', getIssuerDIDDocument);
