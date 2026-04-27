pragma circom 2.1.6;

/*
 * ZK-Auth Login Circuit — auth.circom
 *
 * Proves knowledge of `secret` such that:
 *   1. nullifier_hash = Poseidon(secret, nonce)  — public output, unique per challenge
 *   2. commitment_root = Poseidon(secret)         — public output, matches user record
 *
 * ─── Public inputs (signals known to verifier) ───────────────────────────────
 *   nonce            — 32-byte challenge issued by the server
 *
 * ─── Public outputs (derived, included in publicSignals[]) ───────────────────
 *   nullifier_hash   — prevents replay; stored in auth.nullifiers
 *   commitment_root  — identifies the user; matches auth.users.commitment_hash
 *
 * ─── Private inputs (known only to prover) ───────────────────────────────────
 *   secret           — user's private key (never leaves the client device)
 *
 * ─── Security properties ─────────────────────────────────────────────────────
 *   - Soundness: without secret, no valid (nullifier_hash, commitment_root) pair
 *     satisfying both constraints can be produced.
 *   - Zero-knowledge: the proof reveals nothing about `secret`.
 *   - Replay prevention: nullifier_hash is unique per (secret, nonce) pair;
 *     reusing the same nonce produces the same nullifier (caught by nullifier SET).
 *   - Unlinkability: different nonces → different nullifiers → sessions cannot be
 *     linked to each other by an observer (forward privacy).
 *
 * ─── Dependencies ────────────────────────────────────────────────────────────
 *   circomlib: Poseidon
 */

include "../node_modules/circomlib/circuits/poseidon.circom";

template ZkAuthLogin() {
    // Public inputs
    signal input nonce;              // server-issued challenge nonce

    // Private inputs
    signal input secret;             // user's private key

    // Public outputs (part of publicSignals[])
    signal output nullifier_hash;    // Poseidon(secret, nonce)
    signal output commitment_root;   // Poseidon(secret)

    // ── Compute commitment_root = Poseidon(secret) ───────────────────────────
    component commitHasher = Poseidon(1);
    commitHasher.inputs[0] <== secret;
    commitment_root <== commitHasher.out;

    // ── Compute nullifier_hash = Poseidon(secret, nonce) ────────────────────
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== nonce;
    nullifier_hash <== nullifierHasher.out;
}

component main {public [nonce]} = ZkAuthLogin();
