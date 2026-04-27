/**
 * ZKP Witness Builder — input signal formatting for auth.circom
 *
 * The auth circuit expects:
 *   - nonce:  field element (decimal string) from the server challenge
 *   - secret: field element (decimal string) from the client's local store
 *
 * BN254 scalar field modulus p:
 *   21888242871839275222246405745257275088548364400416034343698204186575808495617
 *
 * All inputs MUST be in range [0, p). We enforce this by reducing inputs
 * modulo p before passing them to snarkjs. Inputs already in range are
 * unaffected; out-of-range inputs (e.g. from a hex secret > p) are reduced.
 *
 * Secret storage contract:
 *   The user's secret is a 32-byte random value generated at registration
 *   and stored in the browser's localStorage under the key 'zk_auth_secret'.
 *   It is NEVER sent to the server. The user must export/backup this value.
 *   Loss of secret = loss of account access (by design — no password reset).
 *
 * Nonce → field element conversion:
 *   Server sends nonce as a 64-char hex string.
 *   We parse it as BigInt then take mod p to get a valid field element.
 */

// BN254 scalar field modulus
const FIELD_MODULUS = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

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
 * Convert a hex string to a BN254 field element (decimal string).
 * Reduces mod p if the value exceeds the field modulus.
 */
function hexToFieldElement(hex: string): bigint {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Invalid hex string for field element conversion`);
  }
  const value = BigInt('0x' + clean);
  return value % FIELD_MODULUS;
}

/**
 * Retrieve the user's secret from localStorage.
 * Returns null if not found (user needs to register or restore backup).
 */
export function loadSecretFromStorage(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('zk_auth_secret');
}

/**
 * Persist a newly generated secret to localStorage.
 * Called once at registration — NEVER called again for the same user.
 *
 * @param secretHex — 64-char hex string (32 random bytes)
 */
export function saveSecretToStorage(secretHex: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('zk_auth_secret', secretHex);
}

/**
 * Generate a new registration secret: 32 cryptographically random bytes.
 * Returns as a 64-char hex string.
 * Must be called only in a browser context (Web Crypto API required).
 */
export function generateRegistrationSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
