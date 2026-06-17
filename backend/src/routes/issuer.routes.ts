import { Router }          from 'express';
import { getIssuerDIDDocument } from '../controllers/ecosystem/issuer.controller.js';
import { postIssueId }     from '../controllers/ecosystem/issuer.controller.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.middleware.js';
import { env } from '../config/env.js';

export const issuerRouter = Router();

const issueRl = rateLimitMiddleware({ endpoint: 'issuer_issue', limit: 5, windowSeconds: 60 });

// POST /api/issuer/verify-token  — validate institutional access token (no auth required)
issuerRouter.post('/verify-token', async (req, res, next) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token || typeof token !== 'string') {
      res.status(400).json({ message: 'token is required' });
      return;
    }
    // Constant-time comparison to prevent timing attacks
    const expected = env.ISSUER_SECRET_TOKEN;
    const valid    = token.length === expected.length &&
      Buffer.from(token).every((b, i) => b === Buffer.from(expected)[i]);
    if (!valid) {
      // Add artificial delay to prevent brute-force enumeration
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 200));
      res.status(401).json({ message: 'Invalid access token' });
      return;
    }
    res.status(200).json({ valid: true, role: 'INSTITUTION_ADMIN', issuer: 'MANIT Bhopal' });
  } catch (err) { next(err); }
});

// POST /api/issuer/issue-id     -- issue a credential (requires X-Issuer-Token)
const issuerTokenMiddleware = async (req: any, res: any, next: any) => {
  const token    = req.headers['x-issuer-token'] as string | undefined;
  const expected = env.ISSUER_SECRET_TOKEN;
  if (!token || token.length !== expected.length ||
      !Buffer.from(token).every((b: number, i: number) => b === Buffer.from(expected)[i])) {
    res.status(401).json({ message: 'Valid X-Issuer-Token header required' });
    return;
  }
  next();
};
issuerRouter.post('/issue-id',       issueRl, issuerTokenMiddleware, postIssueId);

// GET  /api/issuer/did-document — return issuer DID document
issuerRouter.get('/did-document',    getIssuerDIDDocument);

// GET  /api/issuer/history      — issuance history (last 50)
issuerRouter.get('/history',         async (req, res, next) => {
  try {
    const { prisma } = await import('../config/database.js');
    const limit  = Math.min(parseInt((req.query['limit'] as string) ?? '50', 10), 100);
    const offset = parseInt((req.query['offset'] as string) ?? '0', 10);

    const [records, total] = await Promise.all([
      prisma.issuanceRecord.findMany({
        orderBy: { issuedAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.issuanceRecord.count(),
    ]);

    res.status(200).json({
      records: records.map((r) => ({
        id:              r.id,
        credential_id:   r.credentialId,
        credential_type: r.credentialType,
        issuer_did:      r.issuerDid,
        holder_did:      r.holderDid,
        issued_at:       r.issuedAt.toISOString(),
        expires_at:      r.expiresAt?.toISOString() ?? null,
        merkle_root:     r.merkleRoot.substring(0, 16) + '…',
        attributes:      r.attributeSchema,
      })),
      total,
    });
  } catch (err) { next(err); }
});
