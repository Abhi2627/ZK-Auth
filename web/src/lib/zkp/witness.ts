/**
 * ZKP Witness Builder — input signal formatting for auth.circom
 *
 * The auth circuit (auth.circom) computes:
 *   commitment_root = Poseidon([secret])        ← stored at registration
 *   nullifier_hash  = Poseidon([secret, nonce]) ← unique per challenge
 *
 * This module computes the SAME Poseidon hash in the browser so that:
 *   1. commitment_root sent at registration matches what the circuit outputs
 *   2. nullifier in publicSignals matches what snarkjs derives in the proof
 *
 * Poseidon implementation:
 *   We implement the BN254 Poseidon permutation (t=2, width=3, 8+57 rounds)
 *   matching the circomlib implementation used in auth.circom. This avoids
 *   importing circomlibjs (large, ESM issues with Next.js App Router).
 *
 * BN254 scalar field modulus p:
 *   21888242871839275222246405745257275088548364400416034343698204186575808495617
 */

// ─── BN254 field ──────────────────────────────────────────────────────────────

const F = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

function mod(a: bigint): bigint {
  return ((a % F) + F) % F;
}

// ─── Poseidon via circomlibjs ─────────────────────────────────────────────────
// circomlibjs ships the exact circomlib Poseidon implementation used by
// circom's Poseidon() template — same round constants, same field, same output.
// (snarkjs does NOT export buildPoseidon — that lives in circomlibjs.)

/**
 * Compute Poseidon hash of inputs using circomlibjs's Poseidon.
 *
 * @param inputs — array of BigInt field elements, length 1 or 2
 * @returns Poseidon hash as BigInt (BN254 field element)
 */
async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const { buildPoseidon } = await import('circomlibjs');
  const poseidon = await buildPoseidon();
  const result = poseidon(inputs);
  return poseidon.F.toObject(result);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface AuthWitnessInput {
  /** BN254 field element as decimal string — nonce from server */
  nonce: string;
  /** BN254 field element as decimal string — user's local secret */
  secret: string;
}

/**
 * Build the witness input object for auth.circom.
 *
 * @param nonceHex  — 64-char hex nonce from POST /auth/challenge response
 * @param secretHex — 64-char hex secret from localStorage
 */
export function buildAuthWitness(
  nonceHex: string,
  secretHex: string,
): AuthWitnessInput {
  const nonceBigint  = hexToFieldElement(nonceHex);
  const secretBigint = hexToFieldElement(secretHex);
  return {
    nonce:  nonceBigint.toString(10),
    secret: secretBigint.toString(10),
  };
}

/**
 * Compute the ZK commitment = Poseidon([secret]).
 * This is what auth.circom outputs as `commitment_root`.
 * Must be sent to the server at registration as `commitment_hash`.
 *
 * @param secretHex — 64-char hex secret
 * @returns decimal string BN254 field element
 */
export async function computeCommitment(secretHex: string): Promise<string> {
  const secretBigint = hexToFieldElement(secretHex);
  const hash = await poseidonHash([secretBigint]);
  return hash.toString(10);
}

/**
 * Compute the nullifier = Poseidon([secret, nonce]).
 * Matches auth.circom's nullifier_hash output.
 * Used to derive publicSignals[0] for the mock proof fallback.
 *
 * @param secretHex — 64-char hex secret
 * @param nonceHex  — 64-char hex nonce from challenge
 * @returns decimal string BN254 field element
 */
export async function computeNullifier(secretHex: string, nonceHex: string): Promise<string> {
  const secretBigint = hexToFieldElement(secretHex);
  const nonceBigint  = hexToFieldElement(nonceHex);
  const hash = await poseidonHash([secretBigint, nonceBigint]);
  return hash.toString(10);
}

/**
 * Convert a hex string to a BN254 field element.
 * Reduces mod p if value exceeds the field modulus.
 */
function hexToFieldElement(hex: string): bigint {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('Invalid hex string for field element conversion');
  }
  return mod(BigInt('0x' + clean));
}

/**
 * Retrieve the user's secret from localStorage.
 * Returns null if not found (user needs to register).
 */
export function loadSecretFromStorage(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('zk_auth_secret');
}

/**
 * Persist a newly generated secret to localStorage.
 * Called once at registration — NEVER called again for the same user.
 */
export function saveSecretToStorage(secretHex: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('zk_auth_secret', secretHex);
}

/**
 * Generate a new registration secret: 32 cryptographically random bytes.
 * Returns as a 64-char hex string.
 */
export function generateRegistrationSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
