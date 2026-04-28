/**
 * ConsentModal — Granular disclosure consent before proof generation.
 *
 * Renders when a ProofRequest is scanned (QR or deep-link).
 * Shows EXACTLY what is being proved and what is NOT being revealed.
 * User must explicitly approve before any ZKP computation begins.
 *
 * Un-dismissible except via explicit "Approve" or "Decline" — prevents
 * accidental disclosure.
 */

'use client';

import React, { useState, useCallback } from 'react';
import { AnimatePresence, motion }       from 'framer-motion';
import type { ProofRequest, RequestedClaim } from '../../lib/types/vc.types.js';

interface ConsentModalProps {
  request:    ProofRequest | null;
  onApprove:  (request: ProofRequest) => Promise<void>;
  onDecline:  () => void;
}

export function ConsentModal({ request, onApprove, onDecline }: ConsentModalProps) {
  const [generating, setGenerating] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  const handleApprove = useCallback(async () => {
    if (!request) return;
    setGenerating(true);
    setError(null);
    try {
      await onApprove(request);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Proof generation failed');
    } finally {
      setGenerating(false);
    }
  }, [request, onApprove]);

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          key="consent-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={s.backdrop}
          role="dialog"
          aria-modal="true"
          aria-labelledby="consent-title"
        >
          <motion.div
            style={s.panel}
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1,    y: 0, transition: { duration: 0.22, ease: 'easeOut' } }}
            exit={{ scale: 0.95, y: 10, opacity: 0 }}
          >
            {/* Header */}
            <div style={s.header}>
              <span style={s.headerIcon}>🔏</span>
              <div>
                <h2 id="consent-title" style={s.title}>Proof Request</h2>
                <p style={s.subtitle}>from {request.verifier.name}</p>
              </div>
            </div>

            {/* Purpose */}
            <div style={s.purposeBox}>
              <p style={s.purposeLabel}>Purpose</p>
              <p style={s.purposeText}>{request.purpose}</p>
            </div>

            {/* Claims list */}
            <div style={s.claimsSection}>
              <p style={s.claimsHeader}>What will be proved:</p>
              {request.requestedClaims.map((claim, i) => (
                <ClaimRow key={i} claim={claim} />
              ))}
            </div>

            {/* Privacy summary */}
            <div style={s.privacyBox}>
              <p style={s.privacyTitle}>🛡 Zero-Knowledge Guarantee</p>
              <p style={s.privacyText}>
                A mathematical proof is generated on your device. The verifier receives
                only a <strong>YES/NO answer</strong> — no raw values, no dates,
                no personal identifiers are transmitted.
              </p>
            </div>

            {/* Verifier DID */}
            <div style={s.didBox}>
              <span style={s.didLabel}>Verifier DID:</span>
              <code style={s.didValue}>{request.verifier.did}</code>
            </div>

            {/* Expiry */}
            <p style={s.expiry}>
              Request expires: {new Date(request.expiresAt).toLocaleTimeString()}
            </p>

            {/* Error */}
            {error && (
              <div style={s.errorBox} role="alert">
                {error}
              </div>
            )}

            {/* Actions */}
            <div style={s.actions}>
              <button style={s.declineBtn} onClick={onDecline} disabled={generating}>
                Decline
              </button>
              <button
                style={s.approveBtn}
                onClick={handleApprove}
                disabled={generating}
                aria-busy={generating}
              >
                {generating ? 'Generating Proof…' : 'Generate Proof & Approve'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ClaimRow({ claim }: { claim: RequestedClaim }) {
  const predicateSymbol: Record<string, string> = { GTE: '≥', LTE: '≤', EQ: '=' };

  return (
    <div style={s.claimRow}>
      <div style={s.claimLeft}>
        <span style={s.claimBullet}>✓</span>
        <div>
          <p style={s.claimLabel}>{claim.displayLabel}</p>
          <p style={s.claimPredicate}>
            <code style={s.claimCode}>{claim.attributeName}</code>
            {' '}
            <strong>{predicateSymbol[claim.predicate] ?? claim.predicate}</strong>
            {' '}
            <strong>{claim.threshold}</strong>
          </p>
        </div>
      </div>
      <div style={s.privacyStatement}>
        <span style={s.privacyIcon}>🔒</span>
        <span style={s.privacyStatText}>{claim.privacyStatement}</span>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  backdrop:    { position: 'fixed', inset: 0, zIndex: 9998, display: 'flex', alignItems: 'center',
                 justifyContent: 'center', background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)',
                 padding: '16px' },
  panel:       { background: '#0d1117', border: '1px solid #30363d', borderRadius: 12,
                 maxWidth: 520, width: '100%', maxHeight: '90vh', overflowY: 'auto',
                 boxShadow: '0 25px 50px rgba(0,0,0,0.6)' },
  header:      { display: 'flex', alignItems: 'center', gap: 14, padding: '20px 20px 0' },
  headerIcon:  { fontSize: 36 },
  title:       { margin: 0, fontSize: 18, fontWeight: 700, color: '#e6edf3' },
  subtitle:    { margin: '2px 0 0', fontSize: 13, color: '#8b949e' },
  purposeBox:  { margin: '16px 20px 0', padding: '12px', background: '#161b22',
                 borderRadius: 8, border: '1px solid #21262d' },
  purposeLabel: { margin: '0 0 4px', fontSize: 10, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.06em' },
  purposeText: { margin: 0, fontSize: 13, color: '#c9d1d9' },
  claimsSection: { padding: '16px 20px 0' },
  claimsHeader:  { margin: '0 0 10px', fontSize: 12, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.06em' },
  claimRow:    { background: '#161b22', borderRadius: 8, padding: 12, marginBottom: 8, border: '1px solid #21262d' },
  claimLeft:   { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  claimBullet: { color: '#4ade80', fontWeight: 700, marginTop: 1 },
  claimLabel:  { margin: 0, fontSize: 13, fontWeight: 600, color: '#e6edf3' },
  claimPredicate: { margin: '3px 0 0', fontSize: 12, color: '#8b949e' },
  claimCode:   { background: '#0d1117', padding: '1px 4px', borderRadius: 3, color: '#79c0ff', fontFamily: 'monospace' },
  privacyStatement: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '8px 10px',
                      background: '#0a1d0f', borderRadius: 6, border: '1px solid #1a4028' },
  privacyIcon: { fontSize: 12, flexShrink: 0, marginTop: 1 },
  privacyStatText: { fontSize: 11, color: '#4ade80', lineHeight: 1.4 },
  privacyBox:  { margin: '14px 20px 0', padding: 12, background: '#0a1d0f', borderRadius: 8, border: '1px solid #1a4028' },
  privacyTitle: { margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: '#4ade80' },
  privacyText: { margin: 0, fontSize: 12, color: '#3fb950', lineHeight: 1.5 },
  didBox:      { margin: '12px 20px 0', display: 'flex', alignItems: 'center', gap: 8,
                 padding: '8px 10px', background: '#161b22', borderRadius: 6 },
  didLabel:    { fontSize: 11, color: '#8b949e', whiteSpace: 'nowrap' },
  didValue:    { fontSize: 10, color: '#388bfd', fontFamily: 'monospace', wordBreak: 'break-all' },
  expiry:      { margin: '8px 20px 0', fontSize: 11, color: '#484f58', textAlign: 'right' },
  errorBox:    { margin: '12px 20px 0', padding: 10, background: '#450a0a', borderRadius: 6,
                 color: '#f87171', fontSize: 13, border: '1px solid #6e1f1f' },
  actions:     { display: 'flex', gap: 10, padding: '16px 20px 20px' },
  declineBtn:  { flex: 1, background: 'none', border: '1px solid #30363d', color: '#8b949e',
                 borderRadius: 8, padding: '11px', fontSize: 14, cursor: 'pointer' },
  approveBtn:  { flex: 2, background: 'linear-gradient(135deg, #238636, #2ea043)', border: 'none',
                 color: '#fff', borderRadius: 8, padding: '11px', fontSize: 14,
                 fontWeight: 700, cursor: 'pointer' },
};
