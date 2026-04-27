/**
 * Zod validation schemas for credential endpoints.
 */

import { z } from 'zod';
import { parseBody } from './auth.schemas.js';

export { parseBody };

// ─── Shared ───────────────────────────────────────────────────────────────────

const uuidSchema = z.string().uuid({ message: 'Must be a valid UUID' });

const fieldElementSchema = z
  .string()
  .regex(/^\d{1,78}$/, { message: 'Must be a valid BN254 field element (decimal string)' });

const groth16ProofSchema = z
  .object({
    pi_a: z.array(z.string()).length(3),
    pi_b: z.array(z.array(z.string()).length(2)).length(3),
    pi_c: z.array(z.string()).length(3),
    protocol: z.literal('groth16'),
    curve: z.literal('bn254'),
  })
  .strict();

// ─── POST /credential/issue ───────────────────────────────────────────────────

export const issueCredentialSchema = z
  .object({
    user_id: uuidSchema,
    credential_type_id: uuidSchema,
    /**
     * Attribute map: keys must match the credential type's attributeSchema.
     * Values must be non-negative integers within 32-bit range.
     */
    attributes: z
      .record(
        z.string().min(1).max(64),
        z.number().int().nonnegative().max(4_294_967_295),
      )
      .refine((attrs) => Object.keys(attrs).length > 0, {
        message: 'attributes must not be empty',
      })
      .refine((attrs) => Object.keys(attrs).length <= 256, {
        message: 'attributes must not exceed 256 keys',
      }),
    expires_at: z
      .string()
      .datetime({ message: 'expires_at must be an ISO 8601 datetime string' })
      .optional(),
  })
  .strict();

export type IssueCredentialRequest = z.infer<typeof issueCredentialSchema>;

// ─── POST /credential/verify-claim ───────────────────────────────────────────

export const verifyClaimSchema = z
  .object({
    credential_id: uuidSchema,
    proof: groth16ProofSchema,
    /**
     * Exactly 3 public signals from merkle_disclosure.circom:
     *   [0] root       — Merkle root
     *   [1] threshold  — comparison value
     *   [2] leaf_index — attribute position
     */
    public_signals: z
      .tuple([fieldElementSchema, fieldElementSchema, fieldElementSchema])
      .describe('Must be exactly [root, threshold, leaf_index]'),
    /**
     * Human-readable predicate for the audit log.
     * e.g. "clearance_level >= 3"
     */
    claimed_predicate: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_\s>=<!.]+$/, {
        message: 'claimed_predicate contains invalid characters',
      }),
    verifier_id: z
      .string()
      .min(1)
      .max(128)
      .describe('Identifier of the verifying party'),
  })
  .strict();

export type VerifyClaimRequest = z.infer<typeof verifyClaimSchema>;

// ─── POST /credential/revoke ─────────────────────────────────────────────────

export const revokeCredentialSchema = z
  .object({
    credential_id: uuidSchema,
    reason: z.string().min(1).max(256),
  })
  .strict();

export type RevokeCredentialRequest = z.infer<typeof revokeCredentialSchema>;
