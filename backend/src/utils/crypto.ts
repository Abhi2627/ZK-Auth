/**
 * Crypto Utilities
 *
 * Wrappers around Node.js `crypto` for ZK-Auth-specific operations.
 * Business logic that needs hashing or random bytes imports from here,
 * not directly from `crypto`, to keep the API surface narrow.
 *
 * NOTE: Poseidon hashing (used inside ZK circuits) is handled by snarkjs
 * in the ZKP service layer. This module covers non-circuit crypto needs.
 */

import crypto from 'crypto';

/**
 * Generate a cryptographically random nonce as a hex string.
 * Default: 32 bytes = 64 hex chars.
 */
export function generateNonce(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Compute SHA-256 of a string, return hex digest.
 * Used for: refresh token storage, proof metadata hashing.
 */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Use this instead of `===` when comparing secrets or tokens.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generate a UUID v4.
 * Prefer `crypto.randomUUID()` (Node 14.17+) over the `uuid` package
 * for synchronous IDs that don't need custom entropy.
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Encode a Buffer or Uint8Array to a hex string.
 */
export function toHex(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Decode a hex string to a Buffer.
 * Throws if the input is not valid hex.
 */
export function fromHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Invalid hex string: ${hex.slice(0, 16)}…`);
  }
  return Buffer.from(hex, 'hex');
}
