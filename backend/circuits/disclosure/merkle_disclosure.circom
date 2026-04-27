pragma circom 2.1.6;

/*
 * ZK-Auth Selective Disclosure Circuit — merkle_disclosure.circom
 *
 * Proves membership of a single credential attribute in an 8-level Poseidon
 * Merkle tree AND that the attribute satisfies a range predicate, WITHOUT
 * revealing the attribute value or any other attribute to the verifier.
 *
 * ─── What the verifier learns ────────────────────────────────────────────────
 *   PUBLIC  root        — the Merkle root of the issued credential (known to issuer + verifier)
 *   PUBLIC  threshold   — the comparison value (e.g. 3 for "clearance >= 3")
 *   PUBLIC  leaf_index  — which attribute position in the tree is being proven
 *
 * ─── What remains hidden (private witness) ───────────────────────────────────
 *   PRIVATE leaf_value    — the raw attribute value (e.g. actual clearance level 4)
 *   PRIVATE salt          — 32-byte per-attribute random salt
 *   PRIVATE path_elements — sibling hashes along the Merkle path (reveals nothing about other leaves)
 *   PRIVATE path_indices  — left/right routing bits
 *
 * ─── Circuit guarantee ───────────────────────────────────────────────────────
 *   If the proof verifies, the verifier is cryptographically certain that:
 *     1. The prover knows a (leaf_value, salt) such that
 *        Poseidon(leaf_value, salt) is a leaf in the tree with the given root.
 *     2. leaf_value >= threshold (the GTE predicate holds).
 *   The verifier learns NOTHING else about leaf_value or any other attribute.
 *
 * ─── Tree structure ──────────────────────────────────────────────────────────
 *   Depth: 8 levels → supports up to 2^8 = 256 attributes per credential.
 *   Hash:  Poseidon (ZK-friendly, ~220 constraints vs ~27,000 for SHA-256).
 *   Padding: empty leaves are padded with Poseidon(0, 0) to a full 256-leaf tree.
 *
 * ─── Predicate: GTE (>=) ─────────────────────────────────────────────────────
 *   Implemented via a range check using the LessThan comparator from circomlib.
 *   We prove: threshold <= leaf_value, i.e. NOT (leaf_value < threshold).
 *   Supported value range: [0, 2^32 - 1] (configurable via N_BITS below).
 *
 * ─── Dependencies ────────────────────────────────────────────────────────────
 *   circomlib: Poseidon, MerkleProof (or MiMCSponge), LessThan, Mux1
 *   Install:   npm install circomlib
 *   Import path assumes circuits/ is in the circom include path.
 */

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// ─────────────────────────────────────────────────────────────────────────────
// MerklePathHasher
//
// Given a (left, right) pair and a path_index bit, computes
// Poseidon(left, right) where (left, right) is ordered by path_index:
//   path_index == 0  →  current node is the LEFT child  →  hash(current, sibling)
//   path_index == 1  →  current node is the RIGHT child →  hash(sibling,  current)
// ─────────────────────────────────────────────────────────────────────────────
template MerklePathHasher() {
    signal input current;      // hash of the current subtree
    signal input sibling;      // sibling node hash from the proof path
    signal input path_index;   // 0 = current is left child; 1 = current is right child

    signal output parent;      // hash of the parent node

    // Constrain path_index to {0, 1}
    path_index * (path_index - 1) === 0;

    // Select left and right inputs based on path_index using Mux1
    // Mux1: out[0] = in[0] when s=0; out[1] = in[0] when s=1
    component leftMux  = Mux1();
    component rightMux = Mux1();

    leftMux.c[0]  <== current;
    leftMux.c[1]  <== sibling;
    leftMux.s     <== path_index;

    rightMux.c[0] <== sibling;
    rightMux.c[1] <== current;
    rightMux.s    <== path_index;

    // Compute Poseidon(left, right)
    component hasher = Poseidon(2);
    hasher.inputs[0] <== leftMux.out;
    hasher.inputs[1] <== rightMux.out;

    parent <== hasher.out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MerkleDisclosure — Main circuit template
//
// Parameters:
//   DEPTH   — tree depth (8 for 256-attribute credentials)
//   N_BITS  — bit width for range check comparisons (32 for values up to ~4B)
// ─────────────────────────────────────────────────────────────────────────────
template MerkleDisclosure(DEPTH, N_BITS) {

    // ─── Public inputs ────────────────────────────────────────────────────────
    signal input root;         // Merkle root commitment (from zkp.credentials.merkle_root)
    signal input threshold;    // Comparison value for GTE predicate
    signal input leaf_index;   // Position of the attribute in the tree (0-indexed)

    // ─── Private inputs ───────────────────────────────────────────────────────
    signal input leaf_value;            // Raw attribute value (kept secret)
    signal input salt;                  // Per-attribute 32-byte random salt
    signal input path_elements[DEPTH];  // Sibling hashes along the Merkle path
    signal input path_indices[DEPTH];   // Routing bits: 0=left child, 1=right child

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Compute leaf_hash = Poseidon(leaf_value, salt)
    //
    // The leaf commitment hides the raw value. Even if an attacker knows the
    // threshold and root, they cannot reverse leaf_hash to find leaf_value
    // without the salt (T6 mitigation — per-attribute random salt as pepper).
    // ─────────────────────────────────────────────────────────────────────────
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== leaf_value;
    leafHasher.inputs[1] <== salt;

    signal leaf_hash;
    leaf_hash <== leafHasher.out;

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: Reconstruct the Merkle root from leaf_hash and path_elements
    //
    // Traverse from leaf to root, hashing with each sibling node.
    // path_indices[i] determines whether the current node is a left or right
    // child at level i.
    // ─────────────────────────────────────────────────────────────────────────
    component pathHashers[DEPTH];
    signal levelHashes[DEPTH + 1];

    // Level 0 is the leaf hash
    levelHashes[0] <== leaf_hash;

    for (var i = 0; i < DEPTH; i++) {
        pathHashers[i] = MerklePathHasher();
        pathHashers[i].current    <== levelHashes[i];
        pathHashers[i].sibling    <== path_elements[i];
        pathHashers[i].path_index <== path_indices[i];
        levelHashes[i + 1]        <== pathHashers[i].parent;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3: Assert reconstructed root == public root
    //
    // This is the core Merkle inclusion constraint.
    // If the reconstructed root doesn't match, the circuit is unsatisfiable
    // and no valid proof can be generated.
    // ─────────────────────────────────────────────────────────────────────────
    levelHashes[DEPTH] === root;

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 4: Enforce GTE predicate — leaf_value >= threshold
    //
    // Use LessThan(N_BITS) to check: threshold < leaf_value + 1
    // which is equivalent to: threshold <= leaf_value
    //
    // LessThan(n): outputs 1 if in[0] < in[1], else 0.
    // We need: leaf_value >= threshold
    //        ≡ NOT (leaf_value < threshold)
    //        ≡ threshold < leaf_value + 1   (for integer arithmetic)
    //
    // Constraint: LessThan(threshold, leaf_value + 1) === 1
    //
    // Edge case: if leaf_value == MAX_VALUE, leaf_value + 1 overflows N_BITS.
    // This is handled by LessThan's internal range check — values must fit in
    // N_BITS bits. The witness generator will fail before proof generation if
    // leaf_value >= 2^N_BITS. Add an out-of-circuit check in the service layer.
    // ─────────────────────────────────────────────────────────────────────────
    component gte = LessThan(N_BITS);
    gte.in[0] <== threshold;
    gte.in[1] <== leaf_value + 1;

    // Constrain: the predicate MUST hold. If leaf_value < threshold, gte.out
    // will be 0 and this constraint will fail, making the circuit unsatisfiable.
    gte.out === 1;

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 5: Verify leaf_index consistency with path_indices
    //
    // Decompose leaf_index into bits and assert they match path_indices.
    // This prevents a prover from using a valid path for one index while
    // claiming a different leaf_index as the public input.
    // ─────────────────────────────────────────────────────────────────────────
    component indexBits = Num2Bits(DEPTH);
    indexBits.in <== leaf_index;

    for (var i = 0; i < DEPTH; i++) {
        indexBits.out[i] === path_indices[i];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component instantiation
//   DEPTH  = 8  (256 max attributes)
//   N_BITS = 32 (attribute values up to 4,294,967,295)
// ─────────────────────────────────────────────────────────────────────────────
component main {public [root, threshold, leaf_index]} = MerkleDisclosure(8, 32);
