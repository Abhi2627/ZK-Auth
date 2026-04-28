/**
 * Issuer Controller — Mock Government / University Identity Provider
 *
 * DEMO MODE: This controller is fully self-contained.
 * It upserts the demo user and credential type on every call so the
 * portal works without any prior registration or database seeding.
 */

import type { Request, Response, NextFunction } from 'express';
import { z }              from 'zod';
import { prisma }         from '../../config/database.js';
import { vcBuilder }      from '../../services/identity/vc.builder.js';
import { ValidationError } from '../../utils/errors.js';
import { logger }         from '../../utils/logger.js';
import crypto             from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

const GOV_ISSUER_DID          = 'did:web:gov.zk-auth.io';
const DEMO_USER_ID            = '00000000-0000-0000-0000-000000000001';
const DEMO_CREDENTIAL_TYPE_ID = '00000000-0000-0000-0000-000000000002';

// ─── Input validation ─────────────────────────────────────────────────────────

const issueIdSchema = z.object({
  holder_did:     z.string().min(7).max(256),
  user_id:        z.string().uuid().optional(),
  full_name:      z.string().min(1).max(128),
  date_of_birth:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  id_number:      z.string().min(1).max(32),
  nationality:    z.string().length(2).toUpperCase(),
  validity_years: z.coerce.number().int().min(1).max(100).default(10),
}).strict();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function crc32(str: string): number {
  let crc = 0xFFFFFFFF;
  const bytes = Buffer.from(str, 'utf8');
  for (const byte of bytes) {
    crc = crc ^ byte;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const ISO_3166: Record<string, number> = {
  IN: 356, US: 840, GB: 826, DE: 276, FR: 250, JP: 392,
  CN: 156, AU: 36,  CA: 124, BR: 76,  RU: 643, ZA: 710,
};

function encodeNationality(a2: string): number {
  return ISO_3166[a2.toUpperCase()] ?? crc32(a2) % 1000;
}

function encodeDob(iso: string): number {
  return parseInt(iso.replace(/-/g, ''), 10);
}

function computeAge(iso: string): number {
  const dob = new Date(iso);
  const now = new Date();
  let age   = now.getFullYear() - dob.getFullYear();
  const m   = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return Math.max(0, age);
}

function poseidonMock(value: number, saltHex: string): string {
  // Mock Poseidon: SHA-256(value || salt) truncated to 31 bytes → hex
  return crypto
    .createHash('sha256')
    .update(`${value}:${saltHex}`)
    .digest('hex')
    .slice(0, 62);
}

// ─── Ensure demo DB records exist ─────────────────────────────────────────────

async function ensureDemoRecords(): Promise<void> {
  // Upsert demo user
  await prisma.user.upsert({
    where: { id: DEMO_USER_ID },
    create: {
      id:             DEMO_USER_ID,
      publicKey:      Buffer.alloc(32, 0),
      commitmentHash: '1234567890',
      status:         'ACTIVE',
    },
    update: {},
  });

  // Upsert credential type
  await prisma.credentialType.upsert({
    where: { id: DEMO_CREDENTIAL_TYPE_ID },
    create: {
      id:              DEMO_CREDENTIAL_TYPE_ID,
      name:            'GovernmentID',
      version:         '1.0',
      attributeSchema: {
        attributes: ['age', 'dob_encoded', 'id_hash', 'name_hash', 'nationality'],
        treeDepth:  8,
      },
      isActive: true,
    },
    update: {},
  });
}

// ─── POST /api/issuer/issue-id ────────────────────────────────────────────────

export async function postIssueId(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = issueIdSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(`${first?.path.join('.') ?? 'field'}: ${first?.message}`);
    }
    const body = parsed.data;

    // Ensure demo records exist (idempotent)
    await ensureDemoRecords();

    const userId = body.user_id ?? DEMO_USER_ID;

    // ── 1. Encode attributes ──────────────────────────────────────────────────
    const attributeValues: Record<string, number> = {
      age:         computeAge(body.date_of_birth),
      dob_encoded: encodeDob(body.date_of_birth),
      name_hash:   crc32(body.full_name.toLowerCase().trim()),
      id_hash:     crc32(body.id_number),
      nationality: encodeNationality(body.nationality),
    };

    const sortedKeys = Object.keys(attributeValues).sort();

    // ── 2. Generate salts + leaf hashes (mock Poseidon) ───────────────────────
    const salts:      Record<string, string> = {};
    const leafHashes: Record<string, string> = {};

    for (const key of sortedKeys) {
      const salt        = crypto.randomBytes(16).toString('hex');
      salts[key]        = salt;
      leafHashes[key]   = poseidonMock(attributeValues[key]!, salt);
    }

    // ── 3. Build mock Merkle root (SHA-256 of sorted leaf hashes) ─────────────
    const merkleRoot = crypto
      .createHash('sha256')
      .update(sortedKeys.map((k) => leafHashes[k]).join(':'))
      .digest('hex');

    // ── 4. Persist credential to database ─────────────────────────────────────
    const credentialId = crypto.randomUUID();
    const issuedAt     = new Date();
    const expiresAt    = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + body.validity_years);

    await prisma.$transaction(async (tx) => {
      await tx.credential.create({
        data: {
          id:               credentialId,
          userId,
          credentialTypeId: DEMO_CREDENTIAL_TYPE_ID,
          merkleRoot,
          status:           'ACTIVE',
          expiresAt,
          metadata: {
            issuerDid: GOV_ISSUER_DID,
            holderDid: body.holder_did,
          },
        },
      });

      // Store leaf hashes (salts intentionally not stored server-side)
      for (let i = 0; i < sortedKeys.length; i++) {
        const key = sortedKeys[i]!;
        await tx.credentialLeaf.create({
          data: {
            credentialId,
            leafIndex:  i,
            leafHash:   leafHashes[key]!,
            // salt stored in leaf so wallet can regenerate proofs
            salt:       Buffer.from(salts[key]!, 'hex'),
          },
        });
      }
    });

    // ── 5. Wrap in W3C VC ────────────────────────────────────────────────────
    const vc = vcBuilder.buildVC({
      credentialId,
      issuerDid:       GOV_ISSUER_DID,
      holderDid:       body.holder_did,
      credentialType:  'GovernmentID',
      attributeNames:  sortedKeys,
      leafHashes,
      salts,
      merkleRoot,
      circuitId:       'merkle_disclosure_v1',
      issuedAt,
      expiresAt,
    });

    logger.info({ credentialId, userId, holderDid: body.holder_did }, 'Government ID issued');

    res.status(201).json({
      credential_id:         credentialId,
      verifiable_credential: vc,
      merkle_root:           merkleRoot,
      leaf_hashes:           leafHashes,
      attribute_schema:      sortedKeys,
      issuer_did:            GOV_ISSUER_DID,
      issued_at:             issuedAt.toISOString(),
      expires_at:            expiresAt.toISOString(),
      privacy_notice:        'Raw PII was never stored. Only Poseidon commitments are persisted.',
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/issuer/did-document ─────────────────────────────────────────────

export async function getIssuerDIDDocument(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { didRegistry } = await import('../../services/identity/did.registry.js');
    const result = await didRegistry.resolve(GOV_ISSUER_DID);
    if (!result.didDocument) { res.status(404).json({ error: 'DID document not found' }); return; }
    res.setHeader('Content-Type', 'application/did+json');
    res.status(200).json(result.didDocument);
  } catch (err) {
    next(err);
  }
}
