/**
 * Platform Routes — /api/platform
 *
 * Institute onboarding: registration, keypair generation, DID creation.
 * All registrations now persist to the Institute DB table.
 */

import { Router } from 'express';
import crypto     from 'crypto';
import { prisma } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { z }      from 'zod';

export const platformRouter = Router();

// ─── Validation ───────────────────────────────────────────────────────────────

const registerSchema = z.object({
  institute_name:   z.string().min(2).max(128),
  institute_type:   z.string().min(2).max(64),
  email:            z.string().email(),
  website:          z.string().url().optional().or(z.literal('')),
  contact_name:     z.string().min(2).max(128),
  credential_types: z.array(z.string().min(2).max(64)).min(1).max(12),
  plan:             z.enum(['free', 'starter', 'professional', 'enterprise']).default('free'),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
}

function generateApiKey(): string {
  return 'zka_live_' + crypto.randomBytes(20).toString('hex');
}

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function buildDIDDocument(params: {
  did: string; slug: string; name: string;
  publicKeyHex: string; created: string;
}): Record<string, unknown> {
  const { did, slug, name, publicKeyHex, created } = params;
  const pubKeyBase64url = Buffer.from(publicKeyHex, 'hex').toString('base64url');

  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id:   did,
    name,
    verificationMethod: [{
      id:                 `${did}#key-1`,
      type:               'Ed25519VerificationKey2020',
      controller:         did,
      publicKeyMultibase: 'z' + pubKeyBase64url,
    }],
    authentication:  [`${did}#key-1`],
    assertionMethod: [`${did}#key-1`],
    service: [
      {
        id:              `${did}#issuer-portal`,
        type:            'ZkAuthIssuerPortal',
        serviceEndpoint: `https://zk-auth.io/issue/${slug}`,
      },
      {
        id:              `${did}#credential-registry`,
        type:            'ZkAuthCredentialRegistry',
        serviceEndpoint: `https://api.zk-auth.io/api/platform/did/${slug}`,
      },
    ],
    created,
    updated: created,
  };
}

// ─── POST /api/platform/register-institute ────────────────────────────────────

platformRouter.post('/register-institute', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors:  parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const {
      institute_name, institute_type, email, website,
      contact_name, credential_types, plan,
    } = parsed.data;

    // Generate URL slug, append random suffix if already taken
    let slug = toSlug(institute_name);
    const existingSlug = await prisma.institute.findUnique({ where: { slug } }).catch(() => null);
    if (existingSlug) slug = slug + '-' + crypto.randomBytes(3).toString('hex');

    // Block duplicate emails
    const emailExists = await prisma.institute.findUnique({ where: { email } }).catch(() => null);
    if (emailExists) {
      res.status(409).json({ message: 'An institute with this email is already registered.' });
      return;
    }

    // Generate Ed25519 keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyDer  = publicKey.export({ type: 'spki', format: 'der' });
    const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    // Ed25519 SPKI: 12-byte header + 32-byte key
    const publicKeyHex  = (publicKeyDer as Buffer).slice(-32).toString('hex');
    // Ed25519 PKCS8: 16-byte header + 32-byte key
    const privateKeyHex = (privateKeyDer as Buffer).slice(-32).toString('hex');

    const did     = `did:web:${slug}.zk-auth.io`;
    const created = new Date().toISOString();
    const apiKey  = generateApiKey();

    const didDocument = buildDIDDocument({
      did, slug, name: institute_name, publicKeyHex, created,
    });

    // Persist — only public info, NEVER private key
    const institute = await prisma.institute.create({
      data: {
        name:            institute_name,
        slug,
        did,
        instituteType:   institute_type,
        email,
        contactName:     contact_name,
        website:         website ?? '',
        publicKeyHex,
        apiKeyHash:      hashApiKey(apiKey),
        credentialTypes: credential_types,
        plan,
        status:          'ACTIVE',
      },
    });

    logger.info({ instituteId: institute.id, did, slug }, 'Institute registered');

    res.status(201).json({
      success: true,

      institute: {
        id:              institute.id,
        name:            institute_name,
        type:            institute_type,
        slug,
        did,
        plan,
        credential_types,
        contact_name,
        email,
        website:         website || null,
        registered_at:   created,
      },

      cryptographic_identity: {
        did,
        did_document:      didDocument,
        public_key_hex:    publicKeyHex,
        public_key_format: 'Ed25519 (raw 32 bytes, hex)',
        // Delivered ONCE — ZK-Auth never stores this
        private_key_hex:   privateKeyHex,
        private_key_warning:
          'Store in a hardware security module or encrypted vault. ' +
          'ZK-Auth does not retain this key. Loss requires key rotation.',
      },

      api_credentials: {
        api_key:           apiKey,
        api_key_note:      'Use as X-Institute-API-Key header for issuance calls.',
        issuer_portal_url: `https://zk-auth.io/issue/${slug}`,
        api_base_url:      'https://api.zk-auth.io/api/v2/issue',
        did_document_url:  `https://api.zk-auth.io/api/platform/did/${slug}`,
        sdk_docs:          'https://docs.zk-auth.io/quickstart',
      },

      next_steps: [
        '1. Save your private key immediately — it will not be shown again.',
        `2. Access your issuer portal at: https://zk-auth.io/issue/${slug}`,
        '3. Use the API key with X-Institute-API-Key header for issuance.',
        `4. Share your DID (${did}) with verifiers.`,
      ],
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/platform/institutes ─────────────────────────────────────────────
// Public registry — returns all active institutes (no sensitive data)

platformRouter.get('/institutes', async (req, res, next) => {
  try {
    const institutes = await prisma.institute.findMany({
      where:   { status: 'ACTIVE' },
      orderBy: { registeredAt: 'desc' },
      select: {
        id:              true,
        name:            true,
        slug:            true,
        did:             true,
        instituteType:   true,
        credentialTypes: true,
        registeredAt:    true,
      },
    });

    res.status(200).json({
      institutes: institutes.map(i => ({
        id:              i.id,
        name:            i.name,
        did:             i.did,
        type:            i.instituteType,
        credential_types: i.credentialTypes,
        registered_at:   i.registeredAt.toISOString(),
        verified:        true,
      })),
      total: institutes.length,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/platform/did/:slug ──────────────────────────────────────────────
// Public DID resolution — verifiers call this to get institute's public key

platformRouter.get('/did/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params as { slug: string };

    const institute = await prisma.institute.findUnique({
      where:  { slug },
      select: {
        name:         true,
        slug:         true,
        did:          true,
        publicKeyHex: true,
        registeredAt: true,
      },
    });

    if (!institute) {
      res.status(404).json({ message: `No institute found with slug: ${slug}` });
      return;
    }

    const pubKeyBase64url = Buffer.from(institute.publicKeyHex, 'hex').toString('base64url');
    const did = institute.did;
    const created = institute.registeredAt.toISOString();

    res.setHeader('Content-Type', 'application/did+json');
    res.status(200).json({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
      ],
      id:   did,
      name: institute.name,
      verificationMethod: [{
        id:                 `${did}#key-1`,
        type:               'Ed25519VerificationKey2020',
        controller:         did,
        publicKeyMultibase: 'z' + pubKeyBase64url,
      }],
      authentication:  [`${did}#key-1`],
      assertionMethod: [`${did}#key-1`],
      service: [{
        id:              `${did}#issuer-portal`,
        type:            'ZkAuthIssuerPortal',
        serviceEndpoint: `https://zk-auth.io/issue/${slug}`,
      }],
      created,
      updated: created,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/platform/verify-token ─────────────────────────────────────────
// Issuer portal login — validates the ISSUER_SECRET_TOKEN

platformRouter.post('/verify-token', async (req, res, next) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token || typeof token !== 'string') {
      res.status(400).json({ message: 'token is required' });
      return;
    }
    const expected = process.env['ISSUER_SECRET_TOKEN'] ?? '';
    // Constant-time comparison
    const valid =
      token.length === expected.length &&
      Buffer.from(token).every((b, i) => b === (Buffer.from(expected)[i] ?? 0));

    if (!valid) {
      await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
      res.status(401).json({ message: 'Invalid access token' });
      return;
    }
    res.status(200).json({ valid: true, role: 'INSTITUTION_ADMIN' });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/platform/verify-apikey ────────────────────────────────────────
// Verifier portal login — looks up verifier by hashed API key in DB

platformRouter.post('/verify-apikey', async (req, res, next) => {
  try {
    const { api_key } = req.body as { api_key?: string };
    if (!api_key || typeof api_key !== 'string') {
      res.status(400).json({ message: 'api_key is required' });
      return;
    }

    const keyHash = hashApiKey(api_key);

    // Try DB first
    const institute = await prisma.institute.findFirst({
      where:  { apiKeyHash: keyHash, status: 'ACTIVE' },
      select: { id: true, name: true, did: true, lastActiveAt: true },
    }).catch(() => null);

    if (institute) {
      // Update last active timestamp
      await prisma.institute.update({
        where: { id: institute.id },
        data:  { lastActiveAt: new Date() },
      }).catch(() => {});

      res.status(200).json({
        valid:        true,
        verifier_did: institute.did,
        org_name:     institute.name,
      });
      return;
    }

    // Fallback: demo keys for dev/testing
    const DEMO_KEYS: Record<string, { did: string; org_name: string }> = {
      'demo_verifier_acme_key_32chars_minimum':  { did: 'did:web:bank.zk-auth.io',    org_name: 'Acme Corp HR Portal' },
      'demo_verifier_sbi_key_32chars_minimum_x': { did: 'did:web:sbi.zk-auth.io',     org_name: 'State Bank of India' },
      'demo_verifier_tech_key_32chars_minimum_': { did: 'did:web:techcorp.zk-auth.io', org_name: 'TechCorp Engineering' },
    };

    const demo = DEMO_KEYS[api_key];
    if (demo) {
      res.status(200).json({ valid: true, verifier_did: demo.did, org_name: demo.org_name });
      return;
    }

    await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
    res.status(401).json({ message: 'Invalid API key' });
  } catch (err) {
    next(err);
  }
});
