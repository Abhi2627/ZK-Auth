/**
 * DocumentVault — W3C VC display with raw vs. cryptographic commitment distinction.
 *
 * Visual design contract:
 *   "Raw Device Data" column  — greyed-out, blurred — shows attribute names only
 *   "Cryptographic Commitment" column — highlighted, shows Poseidon leaf hashes
 *
 * This UI teaches users that the system holds ZERO raw PII and demonstrates the
 * DigiLocker-parity concept: credentials are stored as mathematical commitments,
 * not plaintext documents.
 */

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { VerifiableCredential } from '../../lib/types/vc.types.js';

interface DocumentVaultProps {
  credentials: StoredCredential[];
  onGenerateProof?: (credential: StoredCredential) => void;
}

export interface StoredCredential {
  id:          string;
  vc:          VerifiableCredential;
  salts:       Record<string, string>;    // held securely in wallet, never sent out
  storedAt:    string;                    // ISO 8601
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DocumentVault({ credentials, onGenerateProof }: DocumentVaultProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (credentials.length === 0) {
    return (
      <div style={s.empty}>
        <p style={s.emptyIcon}>🔐</p>
        <p style={s.emptyTitle}>No credentials in vault</p>
        <p style={s.emptySubtitle}>
          Request a credential from an Issuer to get started.
        </p>
      </div>
    );
  }

  return (
    <div style={s.container}>
      <h2 style={s.heading}>Credential Vault</h2>
      <p style={s.subheading}>
        Your wallet holds cryptographic commitments — never raw personal data.
      </p>

      <ul style={s.list} role="list">
        {credentials.map((cred) => (
          <CredentialCard
            key={cred.id}
            credential={cred}
            isExpanded={expanded === cred.id}
            onToggle={() => setExpanded(expanded === cred.id ? null : cred.id)}
            onGenerateProof={onGenerateProof}
          />
        ))}
      </ul>
    </div>
  );
}

// ─── Credential card ──────────────────────────────────────────────────────────

function CredentialCard({
  credential,
  isExpanded,
  onToggle,
  onGenerateProof,
}: {
  credential:      StoredCredential;
  isExpanded:      boolean;
  onToggle:        () => void;
  onGenerateProof?: (c: StoredCredential) => void;
}) {
  const { vc } = credential;
  const issuerDid = typeof vc.issuer === 'string' ? vc.issuer : vc.issuer?.id ?? '';
  const issuerName = typeof vc.issuer === 'object' ? (vc.issuer as { name?: string }).name : null;
  const credType  = vc.type.find((t) => t !== 'VerifiableCredential' && t !== 'ZkAuthMerkleCredential') ?? 'Credential';
  const subject   = vc.credentialSubject as Record<string, unknown>;
  const attrNames = (subject['attributeNames'] as string[] | undefined) ?? [];
  const leafHashes = (subject['leafHashes'] as Record<string, string> | undefined) ?? {};
  const merkleRoot = vc.zkCommitment?.merkleRoot ?? '';

  const isExpired = vc.validUntil ? new Date(vc.validUntil) < new Date() : false;

  return (
    <motion.li
      layout
      style={{
        ...s.card,
        ...(isExpired ? s.cardExpired : {}),
      }}
    >
      {/* Card header */}
      <button style={s.cardHeader} onClick={onToggle} aria-expanded={isExpanded}>
        <div style={s.cardHeaderLeft}>
          <span style={s.credIcon}>{credTypeIcon(credType)}</span>
          <div>
            <p style={s.credTitle}>{credType}</p>
            <p style={s.credMeta}>
              {issuerName ?? issuerDid} ·{' '}
              {new Date(vc.issuanceDate).toLocaleDateString()}
              {isExpired && <span style={s.expiredBadge}> EXPIRED</span>}
            </p>
          </div>
        </div>
        <span style={s.chevron} aria-hidden="true">{isExpanded ? '▲' : '▼'}</span>
      </button>

      {/* Expanded details */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1, transition: { duration: 0.25 } }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.2 } }}
            style={{ overflow: 'hidden' }}
          >
            <div style={s.details}>
              {/* Two-column comparison */}
              <div style={s.comparisonGrid}>
                {/* Left: Raw Data (blurred — wallet stores commitments, not values) */}
                <div style={s.rawColumn}>
                  <div style={s.columnHeader}>
                    <span style={s.lockIcon}>🔒</span>
                    <span style={s.columnTitle}>Raw Attribute Names</span>
                  </div>
                  <p style={s.columnNote}>
                    Raw values are on your device only — never sent to any server.
                  </p>
                  {attrNames.map((name) => (
                    <div key={name} style={s.rawRow}>
                      <span style={s.attrName}>{formatAttrName(name)}</span>
                      <span style={s.rawValue} title="Raw value stored locally — not in this vault">
                        ••••••••
                      </span>
                    </div>
                  ))}
                </div>

                {/* Right: Cryptographic Commitments */}
                <div style={s.commitColumn}>
                  <div style={s.columnHeader}>
                    <span style={s.lockIcon}>✅</span>
                    <span style={{ ...s.columnTitle, color: '#4ade80' }}>
                      Poseidon Commitments
                    </span>
                  </div>
                  <p style={{ ...s.columnNote, color: '#4ade80' }}>
                    These are what the server holds — mathematically binding but not reversible.
                  </p>
                  {attrNames.map((name) => (
                    <div key={name} style={s.commitRow}>
                      <span style={s.attrName}>{formatAttrName(name)}</span>
                      <code style={s.hashValue}>
                        {truncateHash(leafHashes[name] ?? '')}
                      </code>
                    </div>
                  ))}
                </div>
              </div>

              {/* Merkle root */}
              <div style={s.merkleRoot}>
                <span style={s.merkleLabel}>Merkle Root (public commitment):</span>
                <code style={s.merkleValue}>{truncateHash(merkleRoot, 24)}</code>
              </div>

              {/* Issuer DID */}
              <div style={s.didRow}>
                <span style={s.merkleLabel}>Issuer DID:</span>
                <code style={s.didValue}>{issuerDid}</code>
              </div>

              {/* Action */}
              {!isExpired && onGenerateProof && (
                <button
                  style={s.proofBtn}
                  onClick={() => onGenerateProof(credential)}
                >
                  Generate Selective Disclosure Proof
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function credTypeIcon(type: string): string {
  if (type.toLowerCase().includes('government') || type.toLowerCase().includes('id')) return '🪪';
  if (type.toLowerCase().includes('university') || type.toLowerCase().includes('degree')) return '🎓';
  if (type.toLowerCase().includes('health') || type.toLowerCase().includes('medical')) return '🏥';
  return '📄';
}

function formatAttrName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function truncateHash(hex: string, chars = 12): string {
  if (!hex) return '—';
  const clean = hex.replace(/^0x/, '');
  return `0x${clean.slice(0, chars)}…${clean.slice(-4)}`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  container:     { padding: '0 0 24px' },
  heading:       { fontSize: 20, fontWeight: 700, color: '#e6edf3', marginBottom: 6 },
  subheading:    { fontSize: 13, color: '#8b949e', marginBottom: 20 },
  list:          { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 },
  card:          { background: '#161b22', border: '1px solid #30363d', borderRadius: 10, overflow: 'hidden' },
  cardExpired:   { opacity: 0.6 },
  cardHeader:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                   padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' },
  cardHeaderLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  credIcon:      { fontSize: 28 },
  credTitle:     { margin: 0, fontWeight: 600, color: '#e6edf3', fontSize: 14 },
  credMeta:      { margin: '2px 0 0', fontSize: 12, color: '#8b949e' },
  expiredBadge:  { color: '#f85149', fontWeight: 700 },
  chevron:       { color: '#8b949e', fontSize: 12 },
  details:       { padding: '0 16px 16px' },
  comparisonGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 },
  rawColumn:     { background: '#0d1117', borderRadius: 6, padding: 12, border: '1px solid #21262d' },
  commitColumn:  { background: '#0a1d0f', borderRadius: 6, padding: 12, border: '1px solid #1a4028' },
  columnHeader:  { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
  lockIcon:      { fontSize: 14 },
  columnTitle:   { fontSize: 11, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.06em' },
  columnNote:    { fontSize: 11, color: '#484f58', marginBottom: 10, lineHeight: 1.4 },
  rawRow:        { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #21262d' },
  commitRow:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #1a4028' },
  attrName:      { fontSize: 12, color: '#c9d1d9', fontFamily: 'monospace' },
  rawValue:      { fontSize: 12, color: '#484f58', letterSpacing: '0.1em' },
  hashValue:     { fontSize: 10, color: '#3fb950', fontFamily: 'monospace', wordBreak: 'break-all' },
  merkleRoot:    { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                   background: '#0d1117', borderRadius: 6, marginBottom: 8 },
  merkleLabel:   { fontSize: 11, color: '#8b949e', whiteSpace: 'nowrap' },
  merkleValue:   { fontSize: 11, color: '#4ade80', fontFamily: 'monospace', wordBreak: 'break-all' },
  didRow:        { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                   background: '#0d1117', borderRadius: 6, marginBottom: 12 },
  didValue:      { fontSize: 11, color: '#388bfd', fontFamily: 'monospace', wordBreak: 'break-all' },
  proofBtn:      { width: '100%', background: 'linear-gradient(135deg, #1f6feb, #388bfd)',
                   border: 'none', color: '#fff', borderRadius: 6, padding: '10px',
                   fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  empty:         { textAlign: 'center', padding: '40px 20px', color: '#8b949e' },
  emptyIcon:     { fontSize: 48, marginBottom: 12 },
  emptyTitle:    { fontSize: 16, fontWeight: 600, color: '#e6edf3', margin: '0 0 6px' },
  emptySubtitle: { fontSize: 13, color: '#8b949e', margin: 0 },
};
