/**
 * Issuer Controller — Mock Government / University Identity Provider
 *
 * Route: POST /api/issuer/issue-id
 *
 * Simulates a government identity issuer in the three-actor ecosystem.
 * Accepts raw PII attributes (Name, DOB, ID Number), converts them to
 * numeric field elements, issues a ZK-Auth Merkle credential, and wraps
 * the result in a W3C Verifiable Credential envelope.
 *
 * ─── Attribute encoding ──────────────────────────────────────────────────────
 * The ZKP circuit operates on BN254 field elements (non-negative integers
 * up to 2^32-1 for 32-bit range). String attributes must be encoded as
 * numbers before hashing. We use these stable encodings:
 *
 *   full_name     — CRC32 checksum of canonical form (collision-acceptable for mock)
 *   dob           — YYYYMMDD as integer (e.g. 19950315)
 *   id_number     — CRC32 of the ID string
 *   age           — computed from dob (floor years from today)
 *   nationality   — ISO 3166-1 numeric country code (e.g. 356 for India)
 *
 * In production: use a privacy-preserving encoding like Poseidon(utf8_bytes)
 * but that requires a different circuit parameterisation. For Phase 9 the
 * CRC32/numeric approach is correct and demonstrates the full pipeline.
 *
 * ─── Privacy guarantee ───────────────────────────────────────────────────────
 * The raw PII is NEVER stored in the database. Only Poseidon(value, salt)
 * leaf hashes are persisted. The raw attributes are used only to compute
 * the hashes and are then discarded — they exist in memory for < 1ms.
 */

import type { Request, Response, NextFunction } from 'express';
import { z }                          from 'zod';
import { credentialService }          from '../../services/credential/credential.service.js';
import { vcBuilder }                  from '../../services/identity/vc.builder.js';
import { DIDRegistryService }         from '../../services/identity/did.registry.js';
import { ValidationError }            from '../../utils/errors.js';
import { logger }                     from '../../utils/logger.js';
import { generateId }                 from '../../utils/crypto.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const GOV_ISSUER_DID     = 'did:web:gov.zk-auth.io';
// The credential_type_id for GovernmentID must match a seeded row in zkp.credential_types
// For Phase 9 we use a deterministic UUID seeded at startup
const GOV_CREDENTIAL_TYPE_ID = '00000000-0000-0000-0000-000000000001';

// ─── Input validation ─────────────────────────────────────────────────────────

const issueIdSchema = z.object({
  /** User's DID (wallet-generated) — becomes the VC subject */
  holder_did:     z.string().min(7).max(256),
  /** ZK-Auth internal user ID (from registration) */
  user_id:        z.string().uuid(),
  // ── PII fields (processed in-memory, never stored) ────────────────────────
  full_name:      z.string().min(1).max(128),
  /** ISO 8601 date string: YYYY-MM-DD */
  date_of_birth:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  id_number:      z.string().min(1).max(32),
  /** ISO 3166-1 alpha-2 country code (e.g. 'IN') */
  nationality:    z.string().length(2).toUpperCase(),
  /** Optional expiry years from now (default 10) */
  validity_years: z.coerce.number().int().min(1).max(100).default(10),
}).strict();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Stable CRC32 for string → uint32 encoding */
function crc32(str: string): number {
  let crc = 0xFFFFFFFF;
  const bytes = Buffer.from(str, 'utf8');
  for (const byte of bytes) {
    crc = crc ^ byte;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;   // unsigned 32-bit
}

/** ISO 3166-1 alpha-2 → numeric (partial list) */
const ISO_3166_NUMERIC: Record<string, number> = {
  IN: 356, US: 840, GB: 826, DE: 276, FR: 250, JP: 392,
  CN: 156, AU: 36,  CA: 124, BR: 76,  RU: 643, ZA: 710,
};

function encodeNationality(alpha2: string): number {
  return ISO_3166_NUMERIC[alpha2.toUpperCase()] ?? crc32(alpha2) % 1000;
}

function encodeDob(isoDate: string): number {
  return parseInt(isoDate.replace(/-/g, ''), 10);   // YYYYMMDD integer
}

function computeAge(isoDate: string): number {
  const dob   = new Date(isoDate);
  const today = new Date();
  let age     = today.getFullYear() - dob.getFullYear();
  const m     = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return Math.max(0, age);
}

// ─── Controller ───────────────────────────────────────────────────────────────

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

    // ── 1. Encode PII attributes as field elements ────────────────────────────
    const attributes: Record<string, number> = {
      age:         computeAge(body.date_of_birth),
      dob_encoded: encodeDob(body.date_of_birth),
      name_hash:   crc32(body.full_name.toLowerCase().trim()),
      id_hash:     crc32(body.id_number),
      nationality: encodeNationality(body.nationality),
    };

    // ── 2. Issue internal Merkle credential ───────────────────────────────────
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + body.validity_years);

    const issuanceResult = await credentialService.issueCredential(
      body.user_id,
      GOV_CREDENTIAL_TYPE_ID,
      attributes,
      expiresAt,
    );

    // ── 3. Wrap in W3C VC envelope ────────────────────────────────────────────
    const vc = vcBuilder.buildVC({
      credentialId:    issuanceResult.credentialId,
      issuerDid:       GOV_ISSUER_DID,
      holderDid:       body.holder_did,
      credentialType:  'GovernmentID',
      attributeNames:  Object.keys(attributes).sort(),   // matches sorted leaf order
      leafHashes:      issuanceResult.leafHashes,
      salts:           issuanceResult.salts,
      merkleRoot:      issuanceResult.merkleRoot,
      circuitId:       'merkle_disclosure_v1',
      issuedAt:        issuanceResult.issuedAt,
      expiresAt,
    });

    logger.info(
      {
        credentialId: issuanceResult.credentialId,
        userId:       body.user_id,
        holderDid:    body.holder_did,
        issuerDid:    GOV_ISSUER_DID,
        vcType:       'GovernmentID',
      },
      'Government ID issued as W3C VC',
    );

    res.status(201).json({
      credential_id:      issuanceResult.credentialId,
      verifiable_credential: vc,
      /** Salts are embedded in the VC's credentialSubject for the wallet.
       *  The wallet must store these securely — they're needed to generate proofs. */
      merkle_root:        issuanceResult.merkleRoot,
      issuer_did:         GOV_ISSUER_DID,
      issued_at:          issuanceResult.issuedAt.toISOString(),
      expires_at:         expiresAt.toISOString(),
      attribute_schema:   Object.keys(attributes).sort(),
      privacy_notice:     'Raw PII was never stored. Only Poseidon commitments are persisted.',
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
    const result = await import('../../services/identity/did.registry.js')
      .then((m) => m.didRegistry.resolve(GOV_ISSUER_DID));

    if (!result.didDocument) {
      res.status(404).json({ error: 'DID document not found' });
      return;
    }

    res.setHeader('Content-Type', 'application/did+json');
    res.status(200).json(result.didDocument);
  } catch (err) {
    next(err);
  }
}
