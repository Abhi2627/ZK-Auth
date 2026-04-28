/**
 * DID Registry Service — In-process mock registry
 *
 * In production this would resolve against:
 *   did:web  → HTTPS GET https://{domain}/.well-known/did.json
 *   did:key  → deterministic derivation from multibase-encoded key
 *   did:ion  → Bitcoin-anchored DID (Microsoft ION network)
 *
 * For Phase 9 we implement a hybrid approach:
 *   1. An in-memory registry for mock/test issuers (Government, University).
 *   2. A did:web resolver stub that makes real HTTPS requests in production.
 *   3. A did:key resolver that derives the DID document from the embedded key.
 *
 * ─── Why the Wallet doesn't store the Issuer's public key ─────────────────────
 *
 * In a traditional PKI system, the client (wallet) must either:
 *   (a) hardcode the issuer's public key at app build time (brittle — key rotation
 *       requires a new app release), or
 *   (b) receive the key inline with the credential (trivially forged — an attacker
 *       who issues a fake credential just includes their own key).
 *
 * With the DID registry, the wallet stores ONLY the issuer's DID string
 * (e.g. "did:web:gov.example.com") which is embedded in the VC's `issuer` field.
 * At verification time, the wallet (or verifier) resolves the DID document from
 * the authoritative source — the government's own web server for did:web, or the
 * deterministic key derivation for did:key. The public key is fetched fresh from
 * the source of truth, not from the credential itself. Key rotation requires only
 * updating the DID document at the authoritative endpoint — no wallet update needed.
 *
 * This is the W3C DID trust model: trust the DID method's resolution mechanism,
 * not the credential's self-reported key.
 *
 * ─── Registry cache ───────────────────────────────────────────────────────────
 * Resolved DID documents are cached for CACHE_TTL_MS (5 minutes default) to
 * avoid repeated HTTP round-trips during batch verification. Cache entries are
 * evicted on TTL expiry — the registry never serves stale revocations.
 */

import crypto          from 'crypto';
import type {
  DIDDocument,
  DIDResolutionResult,
  DIDVerificationMethod,
} from './vc.types.js';
import { logger }      from '../../utils/logger.js';
import { generateId }  from '../../utils/crypto.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const VC_CONTEXT_V2     = 'https://www.w3.org/ns/credentials/v2';
export const VC_CONTEXT_V1     = 'https://www.w3.org/2018/credentials/v1';
export const ZKAUTH_VOCAB      = 'https://zk-auth.io/vocab/v1';
export const DID_CONTEXT       = 'https://www.w3.org/ns/did/v1';

const CACHE_TTL_MS             = 5 * 60 * 1_000;   // 5 minutes

// ─── Mock issuer seed data ────────────────────────────────────────────────────

interface MockIssuerConfig {
  did:        string;
  name:       string;
  domain:     string;
  /** Ed25519-compatible keypair for signing (hex strings for mock) */
  publicKeyHex:  string;
  privateKeyHex: string;
}

// Deterministic mock keys — DO NOT use these in production
const MOCK_ISSUERS: MockIssuerConfig[] = [
  {
    did:           'did:web:gov.zk-auth.io',
    name:          'ZK-Auth Mock Government',
    domain:        'gov.zk-auth.io',
    publicKeyHex:  'a' .repeat(64),   // 32-byte mock — replace with real Ed25519
    privateKeyHex: 'b'.repeat(64),
  },
  {
    did:           'did:web:uni.zk-auth.io',
    name:          'ZK-Auth Mock University',
    domain:        'uni.zk-auth.io',
    publicKeyHex:  'c'.repeat(64),
    privateKeyHex: 'd'.repeat(64),
  },
  {
    did:           'did:web:bank.zk-auth.io',
    name:          'ZK-Auth Mock Bank (Verifier)',
    domain:        'bank.zk-auth.io',
    publicKeyHex:  'e'.repeat(64),
    privateKeyHex: 'f'.repeat(64),
  },
];

// ─── Cache entry ─────────────────────────────────────────────────────────────

interface CacheEntry {
  document:   DIDDocument;
  resolvedAt: number;   // Date.now()
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export class DIDRegistryService {
  /** In-memory DID document store (mock issuers + runtime-registered DIDs) */
  private _registry = new Map<string, DIDDocument>();
  /** Resolution cache — evicted after CACHE_TTL_MS */
  private _cache    = new Map<string, CacheEntry>();

  constructor() {
    this._seedMockIssuers();
  }

  // ─── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a new DID document in the in-process registry.
   * Used by the mock issuer/verifier controllers at startup.
   */
  register(document: DIDDocument): void {
    this._registry.set(document.id, document);
    this._cache.delete(document.id);   // invalidate any stale cache entry
    logger.info({ did: document.id }, 'DID registered');
  }

  /**
   * Generate a did:key DID from raw public key bytes.
   * did:key encodes the key type + key bytes as a multibase string.
   * This is deterministic — same key → same DID, no registry needed.
   */
  static generateDidKey(publicKeyHex: string): string {
    // did:key uses multibase-encoded multicodec-prefixed public key
    // For Ed25519: multicodec prefix 0xed01
    const keyBytes    = Buffer.from(publicKeyHex, 'hex');
    const prefixed    = Buffer.concat([Buffer.from([0xed, 0x01]), keyBytes]);
    const multibase   = 'z' + prefixed.toString('base64url');
    return `did:key:${multibase}`;
  }

  /**
   * Generate a DID document for a did:key DID.
   * The document is fully self-describing — no external resolution needed.
   */
  static generateDidKeyDocument(publicKeyHex: string): DIDDocument {
    const did           = DIDRegistryService.generateDidKey(publicKeyHex);
    const keyId         = `${did}#key-1`;
    const keyBytes      = Buffer.from(publicKeyHex, 'hex');

    const verificationMethod: DIDVerificationMethod = {
      id:         keyId,
      type:       'JsonWebKey2020',
      controller: did,
      publicKeyJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        x:   keyBytes.toString('base64url'),
      },
    };

    return {
      '@context':         [DID_CONTEXT, 'https://w3id.org/security/suites/jws-2020/v1'],
      id:                 did,
      verificationMethod: [verificationMethod],
      authentication:     [keyId],
      assertionMethod:    [keyId],
    };
  }

  // ─── Resolution ───────────────────────────────────────────────────────────

  /**
   * Resolve a DID to its DID Document.
   *
   * Resolution chain:
   *   1. Check in-memory cache (TTL = 5 min)
   *   2. Check in-memory registry (mock issuers + runtime-registered)
   *   3. did:key → deterministic derivation (no network call)
   *   4. did:web → HTTPS GET https://{domain}/.well-known/did.json
   *
   * Returns a DIDResolutionResult matching the W3C DID Resolution spec.
   */
  async resolve(did: string): Promise<DIDResolutionResult> {
    const timestamp = new Date().toISOString();

    // ── 1. Cache hit ──────────────────────────────────────────────────────
    const cached = this._cache.get(did);
    if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
      return this._successResult(cached.document, timestamp);
    }

    // ── 2. In-memory registry ─────────────────────────────────────────────
    const inMemory = this._registry.get(did);
    if (inMemory) {
      this._cache.set(did, { document: inMemory, resolvedAt: Date.now() });
      return this._successResult(inMemory, timestamp);
    }

    // ── 3. did:key — deterministic ────────────────────────────────────────
    if (did.startsWith('did:key:')) {
      try {
        const doc = this._resolveDidKey(did);
        this._cache.set(did, { document: doc, resolvedAt: Date.now() });
        return this._successResult(doc, timestamp);
      } catch (err) {
        logger.warn({ did, err }, 'did:key resolution failed');
        return this._errorResult('invalidDid', `Invalid did:key: ${String(err)}`, timestamp);
      }
    }

    // ── 4. did:web — HTTPS fetch ──────────────────────────────────────────
    if (did.startsWith('did:web:')) {
      const result = await this._resolveDidWeb(did, timestamp);
      if (result.didDocument) {
        this._cache.set(did, { document: result.didDocument, resolvedAt: Date.now() });
      }
      return result;
    }

    return this._errorResult('notFound', `Unsupported DID method: ${did}`, timestamp);
  }

  /**
   * Resolve a DID and extract a specific verification method by key ID.
   * Used by the verifier to get the issuer's public key for proof verification.
   */
  async resolveVerificationMethod(
    did:   string,
    keyId: string,
  ): Promise<DIDVerificationMethod | null> {
    const result = await this.resolve(did);
    if (!result.didDocument) return null;

    const { verificationMethod = [] } = result.didDocument;

    // keyId can be a full DID URL or just a fragment (#key-1)
    const normalised = keyId.startsWith('#') ? `${did}${keyId}` : keyId;

    return (
      verificationMethod.find((vm) =>
        typeof vm !== 'string' && vm.id === normalised,
      ) ?? null
    );
  }

  /**
   * Get all registered DIDs (for debugging / admin UI).
   */
  listRegistered(): string[] {
    return Array.from(this._registry.keys());
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _seedMockIssuers(): void {
    for (const issuer of MOCK_ISSUERS) {
      const keyId    = `${issuer.did}#key-1`;
      const keyBytes = Buffer.from(issuer.publicKeyHex, 'hex');

      const doc: DIDDocument = {
        '@context':         [DID_CONTEXT, 'https://w3id.org/security/suites/jws-2020/v1'],
        id:                 issuer.did,
        verificationMethod: [
          {
            id:         keyId,
            type:       'JsonWebKey2020',
            controller: issuer.did,
            publicKeyJwk: {
              kty: 'OKP',
              crv: 'Ed25519',
              x:   keyBytes.toString('base64url'),
            },
          },
        ],
        authentication:  [keyId],
        assertionMethod: [keyId],
        service: [
          {
            id:              `${issuer.did}#credential-service`,
            type:            'CredentialIssuanceService',
            serviceEndpoint: `https://${issuer.domain}/api/issuer`,
          },
          {
            id:              `${issuer.did}#zk-auth`,
            type:            'ZkAuthGateway',
            serviceEndpoint: `https://${issuer.domain}/api/v1`,
          },
        ],
        created: '2025-01-01T00:00:00Z',
        updated: new Date().toISOString(),
      };

      this._registry.set(issuer.did, doc);
    }

    logger.info(
      { count: MOCK_ISSUERS.length, dids: MOCK_ISSUERS.map((i) => i.did) },
      'DID registry: mock issuers seeded',
    );
  }

  private _resolveDidKey(did: string): DIDDocument {
    // did:key:z<multibase> — decode and verify multicodec prefix
    const multibase   = did.replace('did:key:', '');
    if (!multibase.startsWith('z')) throw new Error('Expected multibase prefix z');
    const decoded     = Buffer.from(multibase.slice(1), 'base64url');
    // Check Ed25519 multicodec prefix 0xed01
    if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
      throw new Error('Unsupported key type (expected Ed25519 / 0xed01)');
    }
    const publicKeyBytes = decoded.slice(2);
    const keyId          = `${did}#key-1`;

    return {
      '@context':         [DID_CONTEXT, 'https://w3id.org/security/suites/jws-2020/v1'],
      id:                 did,
      verificationMethod: [
        {
          id:         keyId,
          type:       'JsonWebKey2020',
          controller: did,
          publicKeyJwk: {
            kty: 'OKP',
            crv: 'Ed25519',
            x:   publicKeyBytes.toString('base64url'),
          },
        },
      ],
      authentication:  [keyId],
      assertionMethod: [keyId],
    };
  }

  private async _resolveDidWeb(
    did:       string,
    timestamp: string,
  ): Promise<DIDResolutionResult> {
    // did:web:example.com        → https://example.com/.well-known/did.json
    // did:web:example.com:path   → https://example.com/path/did.json
    const withoutPrefix = did.replace('did:web:', '');
    const parts         = withoutPrefix.split(':');
    const domain        = parts[0];
    const path          = parts.length > 1
      ? parts.slice(1).join('/') + '/did.json'
      : '.well-known/did.json';
    const url           = `https://${domain}/${path}`;

    logger.info({ did, url }, 'Resolving did:web via HTTPS');

    try {
      const resp = await fetch(url, {
        headers: { Accept: 'application/did+json, application/json' },
        signal:  AbortSignal.timeout(5_000),
      });

      if (!resp.ok) {
        return this._errorResult(
          'notFound',
          `did:web resolution HTTP ${resp.status}: ${url}`,
          timestamp,
        );
      }

      const doc = (await resp.json()) as DIDDocument;

      if (doc.id !== did) {
        return this._errorResult(
          'invalidDid',
          `did:web document id mismatch: expected ${did}, got ${doc.id}`,
          timestamp,
        );
      }

      logger.info({ did }, 'did:web resolved successfully');
      return this._successResult(doc, timestamp);

    } catch (err) {
      logger.warn({ did, url, err }, 'did:web resolution failed');
      return this._errorResult('internalError', String(err), timestamp);
    }
  }

  private _successResult(doc: DIDDocument, timestamp: string): DIDResolutionResult {
    return {
      didDocument: doc,
      didResolutionMetadata: {
        contentType: 'application/did+json',
        retrieved:   timestamp,
      },
      didDocumentMetadata: {
        created: doc.created,
        updated: doc.updated,
      },
    };
  }

  private _errorResult(
    error:     DIDResolutionResult['didResolutionMetadata']['error'],
    message:   string,
    timestamp: string,
  ): DIDResolutionResult {
    return {
      didDocument: null,
      didResolutionMetadata: {
        error,
        message,
        retrieved: timestamp,
      },
      didDocumentMetadata: {},
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
export const didRegistry = new DIDRegistryService();
