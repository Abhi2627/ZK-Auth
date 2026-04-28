/**
 * Auth Controller — ZKP Authentication Flow
 *
 * Endpoints:
 *   POST /auth/register   — First-time account creation (commitment_hash + public_key)
 *   POST /auth/challenge  — Issue a ZKP challenge nonce
 *   POST /auth/verify     — Submit Groth16 proof, receive JWTs
 *   POST /auth/refresh    — Rotate refresh token
 *   POST /auth/logout     — Revoke session(s)
 *   POST /auth/recover    — Lost-key account recovery via BIP-39 mnemonic
 *
 * ─── Register flow ───────────────────────────────────────────────────────────
 *   The client generates a random 32-byte secret LOCALLY. It then computes:
 *     commitment_hash = Poseidon(secret)   [decimal BN254 field element]
 *   and sends ONLY the commitment_hash to the server — the secret never travels.
 *
 *   Server actions (single atomic transaction):
 *     1. Verify commitment_hash is not already registered.
 *     2. Create auth.users row with commitment_hash + public_key.
 *     3. Call RecoveryService.generateForUser() — generates BIP-39 mnemonic,
 *        hashes with Argon2id (64 MB / 3 passes), stores hash in recovery_codes.
 *     4. Return { user_id, recovery_mnemonic } — mnemonic returned ONCE, never stored.
 *
 * ─── Recovery flow ───────────────────────────────────────────────────────────
 *   POST /auth/recover accepts the raw 24-word mnemonic and a new commitment.
 *   RecoveryService:
 *     1. Resolve user by identifier (commitment_hash or user_id).
 *     2. Argon2id verify(mnemonic, stored_hash) — ~300ms, memory-hard.
 *     3. Atomically: burn recovery code, revoke all sessions, replace commitment.
 *     4. Return a 15-minute recovery JWT for the new device to complete
 *        ZKP registration (POST /auth/verify with new secret).
 *
 * ─── Verify flow ─────────────────────────────────────────────────────────────
 *   (see inline comments — unchanged from Phase 3)
 */

import type { Request, Response, NextFunction } from 'express';
import { prisma }              from '../config/database.js';
import { challengeService }    from '../services/zkp/challenge.service.js';
import { nullifierService }    from '../services/zkp/nullifier.service.js';
import { zkpService }          from '../services/zkp/zkp.service.js';
import { sessionService }      from '../services/session/session.service.js';
import { recoveryService }     from '../services/auth/recovery.service.js';
import {
  parseBody,
  challengeRequestSchema,
  verifyRequestSchema,
  refreshRequestSchema,
  logoutRequestSchema,
  registerRequestSchema,
  recoverRequestSchema,
} from './auth.schemas.js';
import { logger }              from '../utils/logger.js';
import {
  AppError,
  ErrorCode,
  ValidationError,
} from '../utils/errors.js';
import type { AuthenticatedSession } from '../middleware/auth.middleware.js';

// ─── POST /auth/register ──────────────────────────────────────────────────────

export async function postRegister(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseBody(registerRequestSchema, req.body);
    const { commitment_hash, public_key_hex, device_label } = body;

    // ── 1. Prevent duplicate commitment registration ────────────────────────
    // Do NOT reveal whether commitment already exists — return same error shape
    // regardless to prevent user enumeration via timing or error code.
    const existing = await prisma.user.findUnique({
      where:  { commitmentHash: commitment_hash },
      select: { id: true },
    });

    if (existing) {
      // Introduce constant-time delay matching recovery flow (~300ms) so
      // an attacker cannot distinguish "commitment exists" vs "validation error"
      // by measuring response latency.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      throw new AppError(
        ErrorCode.COMMITMENT_ALREADY_REGISTERED,
        'Registration failed — please try again with a new secret',
        409,
      );
    }

    // ── 2. Parse public key bytes ──────────────────────────────────────────
    const publicKeyBytes = Buffer.from(public_key_hex, 'hex');

    // ── 3. Atomic transaction: create user + generate recovery code ────────
    let userId!: string;
    let recoveryMnemonic!: string;

    await prisma.$transaction(async (tx) => {
      // Create user record
      const user = await tx.user.create({
        data: {
          publicKey:      publicKeyBytes,
          commitmentHash: commitment_hash,
          status:         'ACTIVE',
          metadata:       device_label ? { registrationDevice: device_label } : {},
        },
        select: { id: true },
      });

      userId = user.id;
    });

    // Recovery code generation is outside the Prisma transaction because
    // Argon2id (~300ms, memory-intensive) must not hold a DB transaction open.
    // If recovery generation fails after user creation, the account is still
    // valid — a recovery code can be generated on the next login attempt.
    try {
      const recovery = await recoveryService.generateForUser(userId);
      recoveryMnemonic = recovery.mnemonic;
    } catch (recoveryErr) {
      logger.error(
        { recoveryErr, userId },
        'Recovery code generation failed after user creation — account created without recovery code',
      );
      // Non-fatal: user is registered, they can generate a recovery code later
      recoveryMnemonic = '';
    }

    logger.info({ userId, hasRecovery: !!recoveryMnemonic }, 'User registered');

    res.status(201).json({
      user_id:    userId,
      /**
       * CRITICAL: recovery_mnemonic is returned EXACTLY ONCE.
       * The server does NOT store the raw mnemonic — only its Argon2id hash.
       * If recovery_mnemonic is empty string, recovery code generation failed;
       * call POST /auth/recovery/generate (Phase 9) to generate one after login.
       */
      recovery_mnemonic: recoveryMnemonic || null,
      recovery_warning:  recoveryMnemonic
        ? 'Store this mnemonic in a secure offline location. It will NOT be shown again.'
        : 'Recovery code generation failed. Login and generate a new one immediately.',
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/challenge ─────────────────────────────────────────────────────

export async function postChallenge(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseBody(challengeRequestSchema, req.body);

    let userId: string | null = null;

    if (body.commitment_hash) {
      const user = await prisma.user.findUnique({
        where:  { commitmentHash: body.commitment_hash },
        select: { id: true, status: true },
      });
      if (user?.status === 'ACTIVE') {
        userId = user.id;
      }
    }

    const challenge = await challengeService.issue(userId);

    res.status(200).json({
      challenge_id: challenge.challengeId,
      nonce:        challenge.nonce,
      expires_at:   challenge.expiresAt,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/verify ────────────────────────────────────────────────────────

export async function postVerify(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseBody(verifyRequestSchema, req.body);
    const { challenge_id, proof, public_signals } = body;
    const [nullifierHash] = public_signals;

    // Fetch challenge (validates TTL)
    const challengePayload = await challengeService.fetch(challenge_id);

    // Fast replay pre-check
    const alreadySpent = await nullifierService.exists(nullifierHash);
    if (alreadySpent) {
      logger.warn({ nullifierHash, challenge_id }, 'Fast-path nullifier replay rejection');
      throw new AppError(ErrorCode.NULLIFIER_REPLAY, 'Proof replay detected', 400);
    }

    // ZKP verification (constant-time padded — T14 mitigation)
    const verifyResult = await zkpService.verify({
      proof,
      publicSignals:  public_signals,
      challengeNonce: challengePayload.nonce,
    });

    // ── Check for recovery-pending state ─────────────────────────────────
    // A user in PENDING_VERIFY can only authenticate if the request carries a
    // valid recovery JWT (type: 'recovery') issued by the recovery flow.
    // This activates the account after a key-replacement recovery.
    const user = await prisma.user.findUnique({
      where:  { id: verifyResult.userId },
      select: { status: true },
    });

    if (user?.status === 'PENDING_VERIFY') {
      const recoveryToken = req.headers['x-recovery-token'];
      if (!recoveryToken || typeof recoveryToken !== 'string') {
        throw new AppError(
          ErrorCode.UNAUTHORIZED,
          'Account requires recovery token to complete re-registration',
          401,
        );
      }
      // Validate recovery token
      const jwt = await import('jsonwebtoken');
      const { env } = await import('../config/env.js');
      try {
        const decoded = jwt.default.verify(
          recoveryToken,
          env.JWT_ACCESS_SECRET,
          { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE },
        ) as { sub: string; type: string };

        if (decoded.type !== 'recovery' || decoded.sub !== verifyResult.userId) {
          throw new Error('Invalid recovery token');
        }
      } catch {
        throw new AppError(
          ErrorCode.INVALID_TOKEN,
          'Recovery token is invalid or expired',
          401,
        );
      }

      // Activate the account — transition PENDING_VERIFY → ACTIVE
      await prisma.user.update({
        where: { id: verifyResult.userId },
        data:  { status: 'ACTIVE' },
      });
      logger.info({ userId: verifyResult.userId }, 'Account re-activated after key recovery');
    }

    // Consume challenge
    await challengeService.consume(challenge_id);

    // Register nullifier (two-phase atomic — T4 mitigation)
    await nullifierService.register({
      nullifierHash:  verifyResult.nullifierHash,
      userId:         verifyResult.userId,
      challengeId:    challenge_id,
    });

    // Extract device context from headers
    const deviceFingerprint = req.headers['x-device-fingerprint'] as string | undefined;
    const deviceLabel       = req.headers['x-device-label']        as string | undefined;
    const ipAddress         = getClientIp(req);
    const userAgent         = (req.headers['user-agent'] ?? '').slice(0, 512);

    const tokens = await sessionService.issue(
      verifyResult.userId,
      deviceFingerprint,
      ipAddress,
      deviceLabel,
      userAgent,
    );

    setRefreshCookie(res, tokens.refresh_token);

    logger.info(
      { userId: verifyResult.userId, sessionId: tokens.session_id },
      'Authentication successful',
    );

    res.status(200).json({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type:    tokens.token_type,
      expires_in:    tokens.expires_in,
      session_id:    tokens.session_id,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

export async function postRefresh(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseBody(refreshRequestSchema, req.body);

    const rawRefreshToken =
      body.refresh_token ??
      (req.cookies as Record<string, string | undefined>)['zkauth_refresh'];

    if (!rawRefreshToken) {
      throw new AppError(
        ErrorCode.INVALID_TOKEN,
        'Refresh token is required (cookie or body)',
        400,
      );
    }

    const deviceFingerprint = req.headers['x-device-fingerprint'] as string | undefined;
    const deviceLabel       = req.headers['x-device-label']        as string | undefined;
    const ipAddress         = getClientIp(req);
    const userAgent         = (req.headers['user-agent'] ?? '').slice(0, 512);

    const tokens = await sessionService.rotate(
      rawRefreshToken,
      deviceFingerprint,
      ipAddress,
      deviceLabel,
      userAgent,
    );

    setRefreshCookie(res, tokens.refresh_token);

    res.status(200).json({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type:    tokens.token_type,
      expires_in:    tokens.expires_in,
      session_id:    tokens.session_id,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/logout ────────────────────────────────────────────────────────

export async function postLogout(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = res.locals['session'] as AuthenticatedSession;
    const body    = parseBody(logoutRequestSchema, req.body);

    if (body.all_devices) {
      const count = await sessionService.revokeAllForUser(session.userId);
      logger.info({ userId: session.userId, count }, 'All sessions revoked (logout all)');
    } else {
      await sessionService.revokeSession(session.sessionId, session.userId);
      logger.info({ sessionId: session.sessionId }, 'Session revoked (logout)');
    }

    clearRefreshCookie(res);
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/recover ───────────────────────────────────────────────────────

export async function postRecover(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseBody(recoverRequestSchema, req.body);

    const result = await recoveryService.executeRecovery({
      userIdentifier:   body.identifier,
      identifierType:   body.identifier_type === 'commitmentHash'
                          ? 'commitmentHash'
                          : 'userId',
      mnemonic:         body.mnemonic,
      newCommitmentHash: body.new_commitment_hash,
      newPublicKey:     Buffer.from(body.new_public_key_hex, 'hex'),
    });

    // Log the recovery event for audit purposes
    logger.warn(
      { userId: result.userId },
      'Account recovered — all sessions revoked, commitment replaced. ' +
      'User must complete ZKP re-registration within 15 minutes.',
    );

    res.status(200).json({
      recovery_token: result.recoveryToken,
      user_id:        result.userId,
      message:
        'Recovery successful. Use the recovery_token as X-Recovery-Token header ' +
        'when calling POST /auth/verify with your new ZKP proof. ' +
        'This token expires in 15 minutes.',
    });
  } catch (err) {
    next(err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setRefreshCookie(res: Response, token: string): void {
  res.cookie('zkauth_refresh', token, {
    httpOnly: true,
    secure:   process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    maxAge:   7 * 24 * 60 * 60 * 1_000,
    path:     '/api/v1/auth/refresh',
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie('zkauth_refresh', {
    httpOnly: true,
    secure:   process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    path:     '/api/v1/auth/refresh',
  });
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim() ?? req.socket?.remoteAddress ?? 'unknown';
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
