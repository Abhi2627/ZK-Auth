import { Router } from 'express';
import {
  postSendVerificationRequest,
  getPendingRequests,
  postApproveRequest,
  postRejectRequest,
  getIssuanceHistory,
} from '../controllers/verifyRequest.controller.js';
import { authMiddleware }     from '../middleware/auth.middleware.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.middleware.js';

export const verifyRequestRouter = Router();
export const issuanceRouter       = Router();

const rl = rateLimitMiddleware({ endpoint: 'verify_request', limit: 30, windowSeconds: 60 });

// Third-party verifier sends a request to a specific user
verifyRequestRouter.post('/send',          rl, postSendVerificationRequest);

// User wallet: fetch, approve, reject
verifyRequestRouter.get('/pending',        authMiddleware, getPendingRequests);
verifyRequestRouter.post('/:id/approve',   authMiddleware, postApproveRequest);
verifyRequestRouter.post('/:id/reject',    authMiddleware, postRejectRequest);

// Issuance history for authenticated user
issuanceRouter.get('/history',             authMiddleware, getIssuanceHistory);
