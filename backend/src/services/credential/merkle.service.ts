/**
 * Merkle Tree Service — Poseidon-hashed 8-level tree
 *
 * Builds the same Merkle tree structure as merkle_disclosure.circom so that
 * the server-generated proofs are guaranteed compatible with the ZK circuit.
 *
 * Hash function: Poseidon (via circomlibjs)
 *   - MUST be identical to the Poseidon used in the Circom circuit.
 *   - circomlibjs exports the same Poseidon parameterisation as circomlib.
 *
 * Tree structure:
 *   - DEPTH = 8 → 256 leaf slots (indices 0..255).
 *   - Empty / padding leaves = Poseidon(0, 0).
 *   - Internal nodes: parent = Poseidon(leftChild, rightChild).
 *   - Root = nodes[1] in a 1-indexed array representation.
 *
 * Node indexing (1-indexed binary heap layout):
 *   - Root: index 1
 *   - Left child of node i:  2*i
 *   - Right child of node i: 2*i + 1
 *   - Leaf i (0-indexed) lives at node index: (1 << DEPTH) + i
 *   - Total nodes: 2 * (1 << DEPTH) = 512 for DEPTH=8
 *
 * Proof format (compatible with merkle_disclosure.circom witness):
 *   pathElements[0..DEPTH-1] — sibling hashes from leaf to root
 *   pathIndices[0..DEPTH-1]  — 0 = current is left child; 1 = current is right child
 *                              (matches path_indices in the circuit)
 */

import { buildPoseidon, type Poseidon } from 'circomlibjs';
import { logger } from '../../utils/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const TREE_DEPTH = 8;
export const MAX_LEAVES = 1 << TREE_DEPTH;   // 256

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MerkleTree {
  /** Root commitment as a bigint (field element) */
  root: bigint;
  /** All tree nodes in 1-indexed array. nodes[0] unused. nodes[1] = root. */
  nodes: bigint[];
  /** Leaf hashes in order (index 0..255). Unset leaves = ZERO_LEAF. */
  leaves: bigint[];
}

export interface MerkleProof {
  /** Sibling hashes from leaf level up to root level */
  pathElements: bigint[];
  /** Routing bits: 0 = current node is left child, 1 = right child */
  pathIndices: number[];
  /** The leaf hash being proved */
  leafHash: bigint;
  /** The leaf position (0-indexed) */
  leafIndex: number;
}

// ─── Singleton Poseidon instance ──────────────────────────────────────────────

let _poseidon: Poseidon | null = null;
let _zeroLeaf: bigint | null = null;
/** Zero-value subtree hashes indexed by level (0 = leaf level). */
let _zeroCache: bigint[] | null = null;

async function getPoseidon(): Promise<Poseidon> {
  if (_poseidon === null) {
    _poseidon = await buildPoseidon();
    logger.info('Poseidon hash function initialised (circomlibjs)');
  }
  return _poseidon;
}

/**
 * Compute Poseidon hash of two field elements.
 * Returns a bigint (field element in BN254 scalar field).
 */
async function poseidon2(a: bigint, b: bigint): Promise<bigint> {
  const p = await getPoseidon();
  const result = p.F.toObject(p([a, b]));
  return result as bigint;
}

/**
 * Return the zero-value hash for an empty leaf: Poseidon(0, 0).
 * Cached after first computation.
 */
async function getZeroLeaf(): Promise<bigint> {
  if (_zeroLeaf === null) {
    _zeroLeaf = await poseidon2(0n, 0n);
  }
  return _zeroLeaf;
}

/**
 * Build and cache the zero-value subtree hashes for each level.
 * zeroCache[0] = Poseidon(0, 0)                   (empty leaf hash)
 * zeroCache[1] = Poseidon(zeroCache[0], zeroCache[0])  (level 1)
 * ...
 * zeroCache[DEPTH] = root of all-zero tree
 */
async function getZeroCache(): Promise<bigint[]> {
  if (_zeroCache !== null) return _zeroCache;

  const cache: bigint[] = new Array(TREE_DEPTH + 1);
  cache[0] = await getZeroLeaf();
  for (let i = 1; i <= TREE_DEPTH; i++) {
    cache[i] = await poseidon2(cache[i - 1]!, cache[i - 1]!);
  }
  _zeroCache = cache;
  return cache;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class MerkleService {

  /**
   * Build a Poseidon Merkle tree from an array of leaf hashes.
   *
   * @param leafHashes — Array of leaf hashes as bigint[] (length ≤ 256).
   *                     Must be pre-computed as Poseidon(value, salt).
   *                     Leaves beyond the provided array are padded with ZERO_LEAF.
   * @returns MerkleTree with root, all internal nodes, and leaf array.
   */
  async buildTree(leafHashes: bigint[]): Promise<MerkleTree> {
    if (leafHashes.length > MAX_LEAVES) {
      throw new RangeError(
        `Too many leaves: ${leafHashes.length} exceeds maximum ${MAX_LEAVES}`,
      );
    }

    const zeroCache = await getZeroCache();
    const zeroLeaf = zeroCache[0]!;

    // Pad to full 256 leaves
    const leaves: bigint[] = new Array(MAX_LEAVES).fill(zeroLeaf);
    for (let i = 0; i < leafHashes.length; i++) {
      leaves[i] = leafHashes[i]!;
    }

    // 1-indexed node array: total 2 * MAX_LEAVES = 512 entries
    // nodes[0] unused; nodes[1] = root; leaf i is at nodes[MAX_LEAVES + i]
    const nodes: bigint[] = new Array(2 * MAX_LEAVES).fill(0n);

    // Fill leaf level (nodes[MAX_LEAVES .. nodes[2*MAX_LEAVES - 1]])
    for (let i = 0; i < MAX_LEAVES; i++) {
      nodes[MAX_LEAVES + i] = leaves[i]!;
    }

    // Build internal nodes bottom-up
    for (let i = MAX_LEAVES - 1; i >= 1; i--) {
      const left = nodes[2 * i]!;
      const right = nodes[2 * i + 1]!;
      nodes[i] = await poseidon2(left, right);
    }

    const root = nodes[1]!;

    logger.debug({ root: root.toString(), leafCount: leafHashes.length }, 'Merkle tree built');

    return { root, nodes, leaves };
  }

  /**
   * Generate a Merkle inclusion proof for a specific leaf index.
   *
   * The returned pathElements and pathIndices are directly usable as
   * private witness inputs to merkle_disclosure.circom.
   *
   * @param tree      — MerkleTree built by buildTree()
   * @param leafIndex — 0-indexed position of the leaf to prove
   */
  generateProof(tree: MerkleTree, leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= MAX_LEAVES) {
      throw new RangeError(`leafIndex ${leafIndex} out of range [0, ${MAX_LEAVES})`);
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    // Start at the leaf node in the 1-indexed array
    let nodeIndex = MAX_LEAVES + leafIndex;

    for (let level = 0; level < TREE_DEPTH; level++) {
      const isRightChild = nodeIndex % 2 === 1;
      const siblingIndex = isRightChild ? nodeIndex - 1 : nodeIndex + 1;

      // pathIndex: 0 = current is left child; 1 = current is right child
      pathIndices.push(isRightChild ? 1 : 0);
      pathElements.push(tree.nodes[siblingIndex] ?? 0n);

      // Move up to parent
      nodeIndex = Math.floor(nodeIndex / 2);
    }

    return {
      pathElements,
      pathIndices,
      leafHash: tree.leaves[leafIndex]!,
      leafIndex,
    };
  }

  /**
   * Compute a single leaf hash: Poseidon(value, salt).
   * This is the server-side computation matching the circuit's leaf_hash.
   *
   * @param value — attribute value as bigint (e.g. clearance level = 4n)
   * @param salt  — per-attribute 32-byte random salt as bigint
   */
  async computeLeafHash(value: bigint, salt: bigint): Promise<bigint> {
    return poseidon2(value, salt);
  }

  /**
   * Verify a Merkle proof locally (server-side sanity check before
   * returning proof data to the client).
   *
   * Returns true if the proof reconstructs the expected root.
   */
  async verifyProof(proof: MerkleProof, expectedRoot: bigint): Promise<boolean> {
    let current = proof.leafHash;

    for (let i = 0; i < TREE_DEPTH; i++) {
      const sibling = proof.pathElements[i]!;
      const isRight = proof.pathIndices[i] === 1;

      current = isRight
        ? await poseidon2(sibling, current)   // current is right child
        : await poseidon2(current, sibling);  // current is left child
    }

    return current === expectedRoot;
  }

  /**
   * Convert a hex string (from DB / crypto.generateNonce) to a bigint
   * suitable for use as a Poseidon field element.
   */
  static hexToBigint(hex: string): bigint {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    return BigInt('0x' + clean);
  }

  /**
   * Convert a bigint field element back to a fixed-length hex string.
   * Used when storing Merkle root / leaf hashes as hex in PostgreSQL.
   */
  static bigintToHex(value: bigint): string {
    return value.toString(16).padStart(64, '0');
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const merkleService = new MerkleService();
