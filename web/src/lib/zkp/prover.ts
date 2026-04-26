/**
 * Client-side ZKP prover — stub.
 * Uses SnarkJS WASM to generate a Groth16 proof in the browser.
 * Phase 3 implementation.
 *
 * This runs in a Web Worker to avoid blocking the main thread.
 */

export async function generateAuthProof(
  _secret: string,
  _nonce: string,
): Promise<{ proof: object; publicSignals: string[] }> {
  // Phase 3: snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath)
  throw new Error('Client-side ZKP prover — Phase 3 target');
}
