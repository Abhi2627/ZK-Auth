/**
 * Verification Request Routes
 *
 * POST /api/v1/verify-request/send        — Bank/verifier sends a proof request to a user
 * GET  /api/v1/verify-request/pending     — User fetches their pending requests (wallet)
 * POST /api/v1/verify-request/:id/approve — User approves selected claims
 * POST /api/v1/verify-request/:id/reject  — User rejects the request
 * GET  /api/v1/issuance/history           — Issuer history for the authenticated user
 */

import type { Request, Response, NextFunction } from 'express';
import { z }          from 'zod';
import { prisma }     from '../config/database.js';
import { redis }      from '../config/redis.js';
import { logger }     from '../utils/logger.js';
import { AppError, ErrorCode, ValidationError, NotFoundError } from '../utils/errors.js';
import type { AuthenticatedSession } from '../middleware/auth.middleware.js';
import crypto          from 'crypto';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const sendRequestSchema = z.object({
  user_id:        z.string().uuid(),           // which user to send request to
  verifier_did:   z.string().min(7).max(256),
  verifier_name:  z.string().min(1).max(128),
  purpose:        z.string().min(1).max(512),
  requested_claims: z.array(z.object({
    attribute_name:    z.string(),
    predicate:         z.enum(['GTE', 'LTE', 'EQ']),
    threshold:         z.number(),
    display_label:     z.string(),
    privacy_statement: z.string(),
  })).min(1).max(10),
  ttl_seconds:    z.coerce.number().int().min(60).max(86400).default(3600),
}).strict();

const approveSchema = z.object({
  approved_claim_names: z.array(z.string()).min(1),
}).strict();

const rejectSchema = z.object({
  reason: z.string().max(512).default('User declined verification'),
}).strict();

// ─── POST /api/v1/verify-request/send ────────────────────────────────────────

export async function postSendVerificationRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = sendRequestSchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid request');
    }
    const d = body.data;

    const expiresAt = new Date(Date.now() + d.ttl_seconds * 1000);
    const challenge = crypto.randomBytes(32).toString('hex');

    const request = await prisma.verificationRequest.create({
      data: {
        userId:          d.user_id,
        verifierDid:     d.verifier_did,
        verifierName:    d.verifier_name,
        purpose:         d.purpose,
        requestedClaims: d.requested_claims,
        challenge,
        expiresAt,
      },
    });

    // Push WebSocket notification to user if connected
    try {
      const { pushToUser } = await import('../websocket/wsServer.js');
      pushToUser(d.user_id, {
        type:    'VERIFICATION_REQUEST',
        payload: {
          request_id:   request.id,
          verifier_name: d.verifier_name,
          purpose:       d.purpose,
          claim_count:   d.requested_claims.length,
          expires_at:    expiresAt.toISOString(),
        },
        ts: Date.now(),
      });
    } catch { /* WS push is best-effort */ }

    logger.info({ requestId: request.id, userId: d.user_id, verifierDid: d.verifier_did },
      'Verification request sent to user');

    res.status(201).json({
      request_id:  request.id,
      status:      'PENDING',
      expires_at:  expiresAt.toISOString(),
      message:     'Proof request sent to user wallet. Awaiting their approval.',
    });
  } catch (err) { next(err); }
}

// ─── GET /api/v1/verify-request/pending ──────────────────────────────────────

export async function getPendingRequests(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;

    // Auto-expire old requests
    await prisma.verificationRequest.updateMany({
      where: { userId: session.userId, status: 'PENDING', expiresAt: { lt: new Date() } },
      data:  { status: 'EXPIRED' },
    });

    const requests = await prisma.verificationRequest.findMany({
      where:   { userId: session.userId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({
      requests: requests.map((r) => ({
        id:               r.id,
        verifier_did:     r.verifierDid,
        verifier_name:    r.verifierName,
        purpose:          r.purpose,
        requested_claims: r.requestedClaims,
        challenge:        r.challenge,
        created_at:       r.createdAt.toISOString(),
        expires_at:       r.expiresAt.toISOString(),
      })),
      total: requests.length,
    });
  } catch (err) { next(err); }
}

// ─── POST /api/v1/verify-request/:id/approve ─────────────────────────────────

export async function postApproveRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;
    const { id }  = req.params as { id: string };
    const body    = approveSchema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid');

    const request = await prisma.verificationRequest.findUnique({ where: { id } });
    if (!request || request.userId !== session.userId) throw new NotFoundError('Verification request');
    if (request.status !== 'PENDING') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Request is already ${request.status}`, 400);
    }
    if (request.expiresAt < new Date()) {
      await prisma.verificationRequest.update({ where: { id }, data: { status: 'EXPIRED' } });
      throw new AppError(ErrorCode.CHALLENGE_EXPIRED, 'Verification request has expired', 400);
    }

    const allClaims  = request.requestedClaims as { attribute_name: string }[];
    const approved   = body.data.approved_claim_names;
    const rejected   = allClaims
      .map((c) => c.attribute_name)
      .filter((n) => !approved.includes(n));

    await prisma.verificationRequest.update({
      where: { id },
      data: {
        status:          'APPROVED',
        respondedAt:     new Date(),
        approvedClaims:  approved,
        rejectedClaims:  rejected.length > 0 ? rejected : undefined,
      },
    });

    // Notify verifier via Redis pub/sub (verifier dashboard listens)
    await redis.publish(`vreq:${id}`, JSON.stringify({
      status:           'APPROVED',
      request_id:       id,
      approved_claims:  approved,
      rejected_claims:  rejected,
      responded_at:     new Date().toISOString(),
    }));

    logger.info({ requestId: id, userId: session.userId, approved, rejected }, 'Verification request approved');

    res.status(200).json({
      status:          'APPROVED',
      approved_claims: approved,
      rejected_claims: rejected,
      message: rejected.length > 0
        ? `Approved ${approved.length} claims. Rejected: ${rejected.join(', ')}`
        : 'All claims approved.',
    });
  } catch (err) { next(err); }
}

// ─── POST /api/v1/verify-request/:id/reject ──────────────────────────────────

export async function postRejectRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;
    const { id }  = req.params as { id: string };
    const body    = rejectSchema.safeParse(req.body);
    if (!body.success) throw new ValidationError('Invalid');

    const request = await prisma.verificationRequest.findUnique({ where: { id } });
    if (!request || request.userId !== session.userId) throw new NotFoundError('Verification request');
    if (request.status !== 'PENDING') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Request is already ${request.status}`, 400);
    }

    await prisma.verificationRequest.update({
      where: { id },
      data: {
        status:          'REJECTED',
        respondedAt:     new Date(),
        rejectionReason: body.data.reason,
      },
    });

    await redis.publish(`vreq:${id}`, JSON.stringify({
      status:    'REJECTED',
      request_id: id,
      reason:    body.data.reason,
    }));

    logger.info({ requestId: id, userId: session.userId }, 'Verification request rejected');
    res.status(200).json({ status: 'REJECTED', message: 'Request rejected.' });
  } catch (err) { next(err); }
}

// ─── GET /api/v1/issuance/history ────────────────────────────────────────────

export async function getIssuanceHistory(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;
    const limit   = Math.min(parseInt((req.query['limit'] as string) ?? '20', 10), 100);
    const offset  = parseInt((req.query['offset'] as string) ?? '0', 10);

    const [records, total] = await Promise.all([
      prisma.issuanceRecord.findMany({
        where:   { userId: session.userId },
        orderBy: { issuedAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.issuanceRecord.count({ where: { userId: session.userId } }),
    ]);

    res.status(200).json({
      records: records.map((r) => ({
        id:               r.id,
        credential_id:    r.credentialId,
        credential_type:  r.credentialType,
        issuer_did:       r.issuerDid,
        holder_did:       r.holderDid,
        issued_at:        r.issuedAt.toISOString(),
        expires_at:       r.expiresAt?.toISOString() ?? null,
        merkle_root:      r.merkleRoot.substring(0, 16) + '…',
        attribute_schema: r.attributeSchema,
      })),
      total,
      limit,
      offset,
    });
  } catch (err) { next(err); }
}
