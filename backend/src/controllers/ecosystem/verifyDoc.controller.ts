// QR scan document lookup — exported separately to avoid circular imports
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database.js';

export async function getVerifyDoc(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };

    const record =
      await prisma.issuanceRecord.findFirst({ where: { credentialId: id } }) ??
      await prisma.issuanceRecord.findUnique({ where: { id } });

    if (!record) {
      res.status(200).json({
        verified:   false,
        authentic:  false,
        error:      'Document not found in issuer registry. This credential was not issued by this system.',
        scanned_id: id,
      });
      return;
    }

    const expired = record.expiresAt ? record.expiresAt < new Date() : false;

    res.status(200).json({
      verified:         true,
      authentic:        true,
      document_name:    _docName(record.credentialType),
      document_type:    record.credentialType,
      credential_id:    record.credentialId,
      issuer_name:      _issuerName(record.issuerDid),
      issuer_did:       record.issuerDid,
      holder_did:       record.holderDid,
      issued_at:        record.issuedAt.toISOString(),
      expires_at:       record.expiresAt?.toISOString() ?? null,
      status:           expired ? 'EXPIRED' : 'VALID',
      merkle_root:      record.merkleRoot.substring(0, 16) + '…',
      attribute_schema: record.attributeSchema,
      privacy_notice:   'Document authenticity verified. No PII retrieved or shared.',
    });
  } catch (err) { next(err); }
}

function _docName(type: string): string {
  const m: Record<string, string> = {
    GovernmentID:     'Government Identity Credential (ZK)',
    AdmissionLetter:  'MANIT Bhopal — M.Tech AI Admission Letter',
    AcademicRecord:   'Academic Transcript',
    BirthCertificate: 'Birth Certificate',
  };
  return m[type] ?? type;
}

function _issuerName(did: string): string {
  const m: Record<string, string> = {
    'did:web:gov.zk-auth.io': 'ZK-Auth Mock Government (MANIT Bhopal)',
    'did:web:uni.zk-auth.io': 'ZK-Auth University Node',
    'did:web:bank.zk-auth.io': 'ZK-Auth Bank Node',
  };
  return m[did] ?? did;
}
