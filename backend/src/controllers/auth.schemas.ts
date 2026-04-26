/**
 * Zod validation schemas for all auth endpoint request payloads.
 *
 * Design principles:
 *   - Reject unknown fields (.strict()) to prevent parameter pollution.
 *   - Field-level regex enforce format before any business logic runs.
 *   - Error messages are structured for client consumption but do not
 *     reveal internal implementation details.
 */

import { z } from 'zod';

// ─── Shared field schemas ─────────────────────────────────────────────────────

const uuidSchema = z
  .string()
  .uuid({ message: 'Must be a valid UUID' });

const hexFieldElementSchema = z
  .string()
  .regex(/^\d{1,78}$/, { message: 'Must be a valid BN254 field element (decimal string)' });

const hexStringSchema = z
  .string()
  .regex(/^[0-9a-fA-F]+$/, { message: 'Must be a valid hex string' });

// ─── POST /auth/challenge ─────────────────────────────────────────────────────

export const challengeRequestSchema = z
  .object({
    /**
     * Optional: client-provided commitment_hash to pre-bind the challenge.
     * If provided, the nonce is stored alongside the user identifier.
     * If omitted, challenge is anonymous — userId resolved at proof submission.
     */
    commitment_hash: hexFieldElementSchema.optional(),
  })
  .strict();

export type ChallengeRequest = z.infer<typeof challengeRequestSchema>;

// ─── POST /auth/verify ────────────────────────────────────────────────────────

const groth16ProofSchema = z
  .object({
    pi_a: z
      .array(z.string())
      .length(3, { message: 'pi_a must have exactly 3 elements' }),
    pi_b: z
      .array(z.array(z.string()).length(2))
      .length(3, { message: 'pi_b must have exactly 3 rows of 2 elements' }),
    pi_c: z
      .array(z.string())
      .length(3, { message: 'pi_c must have exactly 3 elements' }),
    protocol: z.literal('groth16', {
      errorMap: () => ({ message: 'Only groth16 protocol is supported' }),
    }),
    curve: z.literal('bn254', {
      errorMap: () => ({ message: 'Only bn254 curve is supported' }),
    }),
  })
  .strict();

export const verifyRequestSchema = z
  .object({
    challenge_id: uuidSchema,
    proof: groth16ProofSchema,
    /**
     * Exactly two public signals from the auth circuit:
     *   [0] nullifier_hash  — decimal string (BN254 field element)
     *   [1] commitment_root — decimal string (BN254 field element)
     */
    public_signals: z
      .tuple([hexFieldElementSchema, hexFieldElementSchema])
      .describe('Must be exactly [nullifier_hash, commitment_root]'),
  })
  .strict();

export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

export const refreshRequestSchema = z
  .object({
    /**
     * Refresh token can be sent in the body (mobile clients) or
     * via HttpOnly cookie (web clients — extracted by controller).
     * One of the two must be present; controller enforces cookie fallback.
     */
    refresh_token: z.string().min(1).optional(),
  })
  .strict();

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

// ─── POST /auth/logout ────────────────────────────────────────────────────────

export const logoutRequestSchema = z
  .object({
    /** If true, revoke all sessions for the user across all devices. */
    all_devices: z.boolean().default(false),
  })
  .strict();

export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

// ─── Zod validation helper ────────────────────────────────────────────────────

import { ValidationError } from '../utils/errors.js';

/**
 * Parse and validate a request body against a Zod schema.
 * On failure, throws a ValidationError with the first human-readable issue.
 */
export function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);

  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join('.') ?? 'unknown';
    const message = firstIssue?.message ?? 'Validation failed';
    throw new ValidationError(`${path}: ${message}`);
  }

  return result.data;
}
