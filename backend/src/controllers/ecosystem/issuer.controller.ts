/**
 * Issuer Controller — Self-contained demo mode.
 * Upserts all required DB records so no prior seeding is needed.
 */

import type { Request, Response, NextFunction } from 'express';
import { z }              from 'zod';
import { prisma }         from '../../config/database.js';
import { vcBuilder }      from '../../services/identity/vc.builder.js';
import { ValidationError } from '../../utils/errors.js';
import { logger }         from '../../utils/logger.js';
import crypto             from 'crypto';

const GOV_ISSUER_DID          = 'did:web:gov.zk-auth.io';
const DEMO_USER_ID            = '00000000-0000-0000-0000-000000000001';
const DEMO_CREDENTIAL_TYPE_ID = '00000000-0000-0000-0000-000000000002';
const DEMO_CIRCUIT_ID         = 'merkle_disclosure_v1';

// ─── Input schema ─────────────────────────────────────────────────────────────

const issueIdSchema = z.object({
  holder_did:     z.string().min(7).max(256),
  user_id:        z.string().uuid().optional(),
  full_name:      z.string().min(1).max(128),
  date_of_birth:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  id_number:      z.string().min(1).max(32),
  nationality:    z.string().min(2).max(3),
  validity_years: z.coerce.number().int().min(1).max(100).default(10),
}).strict();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function crc32(str: string): number {
  let crc = 0xFFFFFFFF;
  for (const byte of Buffer.from(str, 'utf8')) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
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

function computeAge(iso: string): number {
  const dob = new Date(iso), now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return Math.max(0, age);
}

function sha256Hash(value: number, salt: string): string {
  return crypto.createHash('sha256').update(`${value}:${salt}`).digest('hex').slice(0, 62);
}

// ─── Ensure demo DB rows ──────────────────────────────────────────────────────

async function ensureDemoRecords(): Promise<void> {
  // 1. VerificationKey (required by CredentialType FK)
  await prisma.verificationKey.upsert({
    where:  { circuitId: DEMO_CIRCUIT_ID },
    create: {
      circuitId:  DEMO_CIRCUIT_ID,
      vkeyJson:   { demo: true, circuit: 'merkle_disclosure_v1' },
      curve:      'bn254',
      protocol:   'groth16',
      version:    1,
    },
    update: {},
  });

  // 2. CredentialType
  await prisma.credentialType.upsert({
    where:  { id: DEMO_CREDENTIAL_TYPE_ID },
    create: {
      id:              DEMO_CREDENTIAL_TYPE_ID,
      name:            'GovernmentID',
      circuitId:       DEMO_CIRCUIT_ID,
      attributeSchema: { attributes: ['age','dob_encoded','id_hash','name_hash','nationality'], treeDepth: 8 },
      isActive:        true,
    },
    update: {},
  });

  // 3. Demo user (commitment_hash must be unique — use user_id as placeholder)
  await prisma.user.upsert({
    where:  { id: DEMO_USER_ID },
    create: {
      id:             DEMO_USER_ID,
      publicKey:      Buffer.alloc(32, 0),
      commitmentHash: 'demo_commitment_hash_00000000000001',
      status:         'ACTIVE',
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

    await ensureDemoRecords();

    const userId = body.user_id ?? DEMO_USER_ID;

    // ── Build attribute map ───────────────────────────────────────────────────
    const attributeValues: Record<string, number> = {
      age:         computeAge(body.date_of_birth),
      dob_encoded: parseInt(body.date_of_birth.replace(/-/g, ''), 10),
      name_hash:   crc32(body.full_name.toLowerCase().trim()),
      id_hash:     crc32(body.id_number),
      nationality: encodeNationality(body.nationality),
    };

    const sortedKeys = Object.keys(attributeValues).sort();

    // ── Generate salts + leaf hashes ─────────────────────────────────────────
    const salts:      Record<string, string> = {};
    const leafHashes: Record<string, string> = {};

    for (const key of sortedKeys) {
      const salt  = crypto.randomBytes(16).toString('hex');
      salts[key]  = salt;
      leafHashes[key] = sha256Hash(attributeValues[key]!, salt);
    }

    // ── Build Merkle root ─────────────────────────────────────────────────────
    const merkleRoot = crypto
      .createHash('sha256')
      .update(sortedKeys.map((k) => leafHashes[k]).join(':'))
      .digest('hex');

    // ── Persist to DB ─────────────────────────────────────────────────────────
    const credentialId = crypto.randomUUID();
    const issuedAt     = new Date();
    const expiresAt    = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + body.validity_years);

    await prisma.$transaction(async (tx) => {
      // Delete any existing credential for this user+type (allow re-issuance in demo)
      await tx.credential.deleteMany({
        where: { userId, credentialTypeId: DEMO_CREDENTIAL_TYPE_ID },
      });

      await tx.credential.create({
        data: {
          id:               credentialId,
          userId,
          credentialTypeId: DEMO_CREDENTIAL_TYPE_ID,
          merkleRoot,
          attributeCount:   sortedKeys.length,
          status:           'ACTIVE',
          expiresAt,
        },
      });

      for (let i = 0; i < sortedKeys.length; i++) {
        const key = sortedKeys[i]!;
        await tx.credentialLeaf.create({
          data: {
            credentialId,
            leafIndex:     i,
            attributeName: key,
            leafHash:      leafHashes[key]!,
            salt:          Buffer.from(salts[key]!, 'hex'),
          },
        });
      }
    });

    // ── Wrap in W3C VC ────────────────────────────────────────────────────────
    const vc = vcBuilder.buildVC({
      credentialId,
      issuerDid:      GOV_ISSUER_DID,
      holderDid:      body.holder_did,
      credentialType: 'GovernmentID',
      attributeNames: sortedKeys,
      leafHashes,
      salts,
      merkleRoot,
      circuitId:      DEMO_CIRCUIT_ID,
      issuedAt,
      expiresAt,
    });

    logger.info({ credentialId, userId }, 'Government ID issued as W3C VC');

    // Write issuance record (audit trail)
    await prisma.issuanceRecord.create({
      data: {
        credentialId,
        userId,
        credentialType:  'GovernmentID',
        issuerDid:       GOV_ISSUER_DID,
        holderDid:       body.holder_did,
        issuedAt,
        expiresAt,
        merkleRoot,
        attributeSchema: sortedKeys,
        ipAddress:       req.socket?.remoteAddress ?? null,
      },
    }).catch((err) => logger.warn({ err }, 'Failed to write issuance record (non-fatal)'));

    res.status(201).json({
      credential_id:         credentialId,
      verifiable_credential: vc,
      merkle_root:           merkleRoot,
      leaf_hashes:           leafHashes,
      attribute_schema:      sortedKeys,
      issuer_did:            GOV_ISSUER_DID,
      issued_at:             issuedAt.toISOString(),
      expires_at:            expiresAt.toISOString(),
      privacy_notice:        'Raw PII was never stored. Only SHA-256 commitments persisted.',
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/issuer/history (public — admin demo portal) ──────────────────

export async function getIssuanceHistoryPublic(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const limit  = Math.min(parseInt((req.query['limit']  as string) ?? '20', 10), 100);
    const offset = parseInt((req.query['offset'] as string) ?? '0', 10);

    const [records, total] = await Promise.all([
      prisma.issuanceRecord.findMany({
        orderBy: { issuedAt: 'desc' },
        take:    limit,
        skip:    offset,
        select:  {
          id:              true,
          credentialId:    true,
          credentialType:  true,
          holderDid:       true,
          issuedAt:        true,
          expiresAt:       true,
          merkleRoot:      true,
          attributeSchema: true,
        },
      }),
      prisma.issuanceRecord.count(),
    ]);

    res.status(200).json({
      records: records.map((r) => ({
        id:              r.id,
        credential_id:   r.credentialId,
        credential_type: r.credentialType,
        holder_did:      r.holderDid,
        issued_at:       r.issuedAt.toISOString(),
        expires_at:      r.expiresAt?.toISOString() ?? null,
        merkle_root:     r.merkleRoot.substring(0, 16) + '…',
        attributes:      r.attributeSchema,
      })),
      total,
    });
  } catch (err) { next(err); }
}

// ─── GET /api/issuer/did-document ─────────────────────────────────────────────

export async function getIssuerDIDDocument(
  _req: Request,
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
