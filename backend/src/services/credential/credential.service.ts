/**
 * Credential Service — Issuance
 *
 * Issues a Merkle-committed credential for a user.
 *
 * ─── Issuance flow ────────────────────────────────────────────────────────────
 *   1. Validate credential type exists and is active.
 *   2. Validate attribute keys match the type's attributeSchema.
 *   3. For each attribute:
 *        a. Generate 32-byte cryptographically random salt.
 *        b. Compute leaf_hash = Poseidon(attribute_value_bigint, salt_bigint).
 *           This matches the leaf_hash computation in merkle_disclosure.circom.
 *   4. Build the Poseidon Merkle tree from all leaf hashes.
 *   5. Transactional PG write:
 *        a. Upsert zkp.credentials (userId + typeId unique — one active per type).
 *        b. Insert all zkp.credential_leaves (hash + salt per attribute).
 *        c. If upsert replaces an existing credential: delete old leaves first.
 *
 * ─── Security invariants ──────────────────────────────────────────────────────
 *   - Raw attribute VALUES are NEVER written to the database.
 *   - Only leaf_hash = Poseidon(value, salt) and the salt are stored.
 *   - Salts are stored as Buffer in the credential_leaves table.
 *   - The returned salts are sent to the client ONCE at issuance — they
 *     are needed by the client to construct proofs. If lost, re-issuance is required.
 *   - Merkle root is stored in zkp.credentials and is the sole public commitment.
 *
 * ─── T6 Mitigation (Selective Disclosure Linkage) ───────────────────────────
 *   The root R is re-computed from fresh salts on every re-issuance.
 *   Different issuances of the "same" credential for the same user produce
 *   different roots, preventing verifiers from correlating proofs across issuances.
 */

import { prisma } from '../../config/database.js';
import { merkleService, MerkleService, TREE_DEPTH } from './merkle.service.js';
import { generateNonce, generateId } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import {
  AppError,
  ErrorCode,
  NotFoundError,
  ValidationError,
} from '../../utils/errors.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AttributeInput {
  [attributeName: string]: number | string;
}

export interface IssuanceResult {
  credentialId: string;
  merkleRoot: string;           // hex — public commitment
  /** Per-attribute salts returned to the client ONCE. Map: attrName → hex salt. */
  salts: Record<string, string>;
  leafHashes: Record<string, string>;
  issuedAt: Date;
}

export interface CredentialLeafData {
  attributeName: string;
  leafIndex: number;
  leafHash: bigint;
  salt: bigint;
  saltHex: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class CredentialService {

  /**
   * Issue a new credential for a user.
   *
   * @param userId        — UUID of the authenticated user
   * @param credentialTypeId — UUID of the credential type from zkp.credential_types
   * @param attributes    — Key-value map of attribute names to numeric values
   * @param expiresAt     — Optional expiry for the credential
   */
  async issueCredential(
    userId: string,
    credentialTypeId: string,
    attributes: AttributeInput,
    expiresAt?: Date,
  ): Promise<IssuanceResult> {

    // ── 1. Validate credential type ──────────────────────────────────────────
    const credType = await prisma.credentialType.findUnique({
      where: { id: credentialTypeId },
      select: {
        id: true,
        name: true,
        attributeSchema: true,
        isActive: true,
        circuitId: true,
      },
    });

    if (!credType) {
      throw new NotFoundError('CredentialType');
    }

    if (!credType.isActive) {
      throw new AppError(
        ErrorCode.CREDENTIAL_NOT_FOUND,
        'Credential type is not active',
        400,
      );
    }

    // ── 2. Validate attribute keys match schema ───────────────────────────────
    const schema = credType.attributeSchema as Record<string, string>;
    const schemaKeys = Object.keys(schema);
    const providedKeys = Object.keys(attributes);

    const missingKeys = schemaKeys.filter((k) => !providedKeys.includes(k));
    const extraKeys = providedKeys.filter((k) => !schemaKeys.includes(k));

    if (missingKeys.length > 0) {
      throw new ValidationError(
        `Missing required attributes: ${missingKeys.join(', ')}`,
      );
    }

    if (extraKeys.length > 0) {
      throw new ValidationError(
        `Unknown attributes: ${extraKeys.join(', ')}`,
      );
    }

    // Validate all values are numeric (circuit operates on field elements)
    for (const [key, value] of Object.entries(attributes)) {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0 || num > 2 ** 32 - 1) {
        throw new ValidationError(
          `Attribute '${key}' must be a non-negative integer ≤ 4294967295 (32-bit range)`,
        );
      }
    }

    // ── 3. Generate salts and compute leaf hashes ────────────────────────────
    // Attribute order is sorted alphabetically for deterministic leaf indices.
    // This ordering is documented in the attributeSchema and must be stable.
    const sortedKeys = schemaKeys.sort();

    if (sortedKeys.length > (1 << TREE_DEPTH)) {
      throw new ValidationError(
        `Too many attributes: ${sortedKeys.length} exceeds tree capacity ${1 << TREE_DEPTH}`,
      );
    }

    const leafData: CredentialLeafData[] = [];
    const leafHashes: bigint[] = [];

    for (let i = 0; i < sortedKeys.length; i++) {
      const attrName = sortedKeys[i]!;
      const value = Number(attributes[attrName]);
      const valueBigint = BigInt(value);

      // 32-byte random salt — unique per attribute per issuance
      const saltHex = generateNonce(32);
      const saltBigint = MerkleService.hexToBigint(saltHex);

      // leaf_hash = Poseidon(value, salt) — must match the circuit
      const leafHash = await merkleService.computeLeafHash(valueBigint, saltBigint);

      leafData.push({
        attributeName: attrName,
        leafIndex: i,
        leafHash,
        salt: saltBigint,
        saltHex,
      });

      leafHashes.push(leafHash);
    }

    // ── 4. Build Merkle tree ──────────────────────────────────────────────────
    const tree = await merkleService.buildTree(leafHashes);
    const merkleRootHex = MerkleService.bigintToHex(tree.root);

    logger.info(
      { userId, credentialTypeId, attributeCount: sortedKeys.length, merkleRoot: merkleRootHex },
      'Merkle tree built for credential issuance',
    );

    // ── 5. Transactional PostgreSQL write ─────────────────────────────────────
    const credentialId = generateId();
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      // Revoke any existing active credential of this type for this user
      const existing = await tx.credential.findFirst({
        where: {
          userId,
          credentialTypeId,
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      if (existing) {
        // Delete old leaves first (cascades in schema but explicit for audit clarity)
        await tx.credentialLeaf.deleteMany({
          where: { credentialId: existing.id },
        });
        // Mark old credential as REVOKED
        await tx.credential.update({
          where: { id: existing.id },
          data: { status: 'REVOKED', revokedAt: now, revocationReason: 'REISSUED' },
        });
      }

      // Insert new credential row
      await tx.credential.create({
        data: {
          id: credentialId,
          userId,
          credentialTypeId,
          merkleRoot: merkleRootHex,
          attributeCount: sortedKeys.length,
          status: 'ACTIVE',
          issuedAt: now,
          expiresAt: expiresAt ?? null,
        },
      });

      // Insert credential leaves (hash + salt — NO raw values)
      await tx.credentialLeaf.createMany({
        data: leafData.map((leaf) => ({
          id: generateId(),
          credentialId,
          leafIndex: leaf.leafIndex,
          attributeName: leaf.attributeName,
          leafHash: MerkleService.bigintToHex(leaf.leafHash),
          // Salt stored as Buffer — pgcrypto encryption applied at DB column level
          // (see init_postgres.sql column comment)
          salt: Buffer.from(leaf.saltHex, 'hex'),
        })),
      });
    });

    logger.info(
      { credentialId, userId, merkleRoot: merkleRootHex },
      'Credential issued and persisted',
    );

    // ── 6. Build response — salts returned ONCE to the client ─────────────────
    const saltsMap: Record<string, string> = {};
    const leafHashesMap: Record<string, string> = {};

    for (const leaf of leafData) {
      saltsMap[leaf.attributeName] = leaf.saltHex;
      leafHashesMap[leaf.attributeName] = MerkleService.bigintToHex(leaf.leafHash);
    }

    return {
      credentialId,
      merkleRoot: merkleRootHex,
      salts: saltsMap,
      leafHashes: leafHashesMap,
      issuedAt: now,
    };
  }

  /**
   * Fetch a credential record for a user (metadata only — no raw attributes).
   */
  async getCredential(credentialId: string, userId: string) {
    const credential = await prisma.credential.findUnique({
      where: { id: credentialId },
      include: {
        credentialType: {
          select: { name: true, circuitId: true },
        },
        leaves: {
          select: {
            leafIndex: true,
            attributeName: true,
            leafHash: true,
            // salt NOT included — never returned via API
          },
          orderBy: { leafIndex: 'asc' },
        },
      },
    });

    if (!credential || credential.userId !== userId) {
      throw new NotFoundError('Credential');
    }

    return credential;
  }

  /**
   * Revoke a credential explicitly.
   */
  async revokeCredential(
    credentialId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    const credential = await prisma.credential.findUnique({
      where: { id: credentialId },
      select: { userId: true, status: true },
    });

    if (!credential || credential.userId !== userId) {
      throw new NotFoundError('Credential');
    }

    if (credential.status === 'REVOKED') {
      return; // idempotent
    }

    await prisma.credential.update({
      where: { id: credentialId },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revocationReason: reason,
      },
    });

    logger.info({ credentialId, userId, reason }, 'Credential revoked');
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const credentialService = new CredentialService();
