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

// ─── POST /auth/register ─────────────────────────────────────────────────────
// First-time account creation. The client generates a secret locally and
// provides Poseidon(secret) as the commitment_hash — the raw secret never
// leaves the client device.

export const registerRequestSchema = z
  .object({
    /**
     * Poseidon(secret) — the user's ZKP commitment.
     * This is the only identifier the server stores that relates to the secret.
     * Decimal BN254 field element string.
     */
    commitment_hash: hexFieldElementSchema,
    /**
     * Raw public key bytes from the client device (hex-encoded 32 bytes).
     * Stored as Bytes in auth.users.public_key.
     */
    public_key_hex: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, {
        message: 'public_key_hex must be exactly 64 hex characters (32 bytes)',
      }),
    /** Optional human-readable device label for the device management UI. */
    device_label: z.string().max(128).optional(),
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

// ─── POST /auth/recover ───────────────────────────────────────────────────────
// Lost-key recovery. The user submits their 24-word BIP-39 mnemonic and
// a new commitment_hash from the replacement device.

export const recoverRequestSchema = z
  .object({
    /**
     * How the user identifies their account:
     *   'commitmentHash' — old Poseidon(secret) value (if the user remembers it)
     *   'userId'         — UUID (if stored by the client application)
     */
    identifier_type: z.enum(['commitmentHash', 'userId']),
    identifier:      z.string().min(1).max(128),
    /**
     * Raw 24-word BIP-39 mnemonic phrase (space-separated words).
     * Verified against the Argon2id hash in auth.recovery_codes.
     */
    mnemonic: z
      .string()
      .regex(
        /^([a-z]+ ){23}[a-z]+$/,
        { message: 'mnemonic must be exactly 24 lowercase words separated by spaces' },
      ),
    /**
     * New Poseidon(secret) commitment from the replacement device.
     * Decimal BN254 field element string.
     */
    new_commitment_hash: hexFieldElementSchema,
    /**
     * New public key from the replacement device (hex-encoded 32 bytes).
     */
    new_public_key_hex: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, {
        message: 'new_public_key_hex must be exactly 64 hex characters',
      }),
  })
  .strict();

export type RecoverRequest = z.infer<typeof recoverRequestSchema>;

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
