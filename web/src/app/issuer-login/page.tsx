'use client';

/**
 * Issuer Login Page — MANIT Admin Authentication
 *
 * The Issuer is an institutional actor (MANIT University admin).
 * Security model: simple token-based auth using ISSUER_SECRET_TOKEN.
 * Token is stored in sessionStorage (not localStorage) for the session.
 *
 * In a production deployment this would be SAML/OIDC SSO via the
 * university's identity provider. For demo/paper purposes, token auth
 * is sufficient and architecturally distinct from the ZKP holder flow.
 *
 * Access level: INSTITUTION_ADMIN
 * Portal: /issuer (protected — redirects here if no valid token)
 */

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

export default function IssuerLoginPage() {
  const [token, setToken]     = useState('');
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async () => {
    if (!token.trim()) { setError('Enter the issuer access token.'); return; }
    setLoading(true);
    setError(null);

    try {
      // Verify token against backend
      const r = await fetch(`${API}/api/issuer/verify-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });

      if (!r.ok) {
        const d = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(d.message ?? 'Invalid token');
      }

      // Store token for portal use
      sessionStorage.setItem('issuer_token', token.trim());
      router.push('/issuer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={s.page}>
      <div style={s.card}>
        {/* Header */}
        <div style={s.header}>
          <span style={s.icon}>🎓</span>
          <div>
            <h1 style={s.title}>MANIT Bhopal</h1>
            <p style={s.subtitle}>ZK-Auth Credential Issuer Portal</p>
          </div>
        </div>

        <div style={s.divider} />

        <p style={s.desc}>
          This portal is restricted to <strong>MANIT administrative staff</strong> authorised
          to issue W3C Verifiable Credentials. Enter your institutional access token below.
        </p>

        {/* Role badge */}
        <div style={s.roleBadge}>
          <span style={s.roleIcon}>🔐</span>
          <span>Access Level: <strong>INSTITUTION_ADMIN</strong></span>
        </div>

        {/* Token input */}
        <div style={s.fieldGroup}>
          <label style={s.label}>Institutional Access Token</label>
          <input
            type="password"
            placeholder="Enter issuer secret token..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            style={s.input}
            autoComplete="current-password"
          />
          <p style={s.hint}>
            Provided by MANIT IT department. Contact registrar@manit.ac.in if you do not have access.
          </p>
        </div>

        {error && <div style={s.error}>{error}</div>}

        <button
          style={{ ...s.btn, opacity: loading ? 0.6 : 1 }}
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? 'Verifying...' : '🔐 Access Issuer Portal'}
        </button>

        {/* Comparison with user auth */}
        <div style={s.infoBox}>
          <p style={s.infoTitle}>Why is issuer auth different from holder auth?</p>
          <p style={s.infoText}>
            Holders (students) authenticate using <strong>Zero-Knowledge Proofs</strong> —
            they prove knowledge of a secret without revealing it, with no trusted party.
            Issuers (institutions) use <strong>institutional token auth</strong> because
            they are trusted entities in the ecosystem by design. In production this
            would be SAML/OIDC SSO via the university identity provider.
          </p>
        </div>

        <p style={s.footer}>
          Not an issuer?&nbsp;
          <a href="/login" style={s.link}>Holder login</a>
          &nbsp;|&nbsp;
          <a href="/verifier-login" style={s.link}>Verifier portal</a>
        </p>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page:      { minHeight: '100vh', background: '#010409', display: 'flex', alignItems: 'center',
               justifyContent: 'center', fontFamily: 'system-ui, sans-serif', padding: 24 },
  card:      { background: '#0d1117', border: '1px solid #21262d', borderRadius: 14,
               padding: 36, width: '100%', maxWidth: 480 },
  header:    { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 },
  icon:      { fontSize: 44 },
  title:     { margin: 0, fontSize: 22, fontWeight: 800, color: '#e6edf3' },
  subtitle:  { margin: 0, fontSize: 12, color: '#8b949e' },
  divider:   { height: 1, background: '#21262d', margin: '0 0 20px' },
  desc:      { fontSize: 13, color: '#8b949e', lineHeight: 1.6, margin: '0 0 16px' },
  roleBadge: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
               background: '#1a2d1a', border: '1px solid #2ea04344', borderRadius: 8,
               fontSize: 13, color: '#4ade80', marginBottom: 20 },
  roleIcon:  { fontSize: 16 },
  fieldGroup:{ marginBottom: 16 },
  label:     { display: 'block', fontSize: 11, color: '#8b949e', marginBottom: 6,
               fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' },
  input:     { width: '100%', background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
               color: '#e6edf3', padding: '10px 12px', fontSize: 14, boxSizing: 'border-box',
               fontFamily: 'monospace' },
  hint:      { margin: '6px 0 0', fontSize: 11, color: '#484f58' },
  error:     { background: '#1a0505', border: '1px solid #6e1f1f', borderRadius: 8,
               color: '#f87171', fontSize: 13, padding: '10px 12px', marginBottom: 14 },
  btn:       { width: '100%', background: 'linear-gradient(135deg, #238636, #2ea043)',
               border: 'none', color: '#fff', borderRadius: 8, padding: '13px',
               fontSize: 15, fontWeight: 700, cursor: 'pointer', marginBottom: 20 },
  infoBox:   { background: '#0d1a2d', border: '1px solid #1f3a5f44', borderRadius: 8,
               padding: '14px 16px', marginBottom: 16 },
  infoTitle: { margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#79c0ff' },
  infoText:  { margin: 0, fontSize: 12, color: '#8b949e', lineHeight: 1.5 },
  footer:    { margin: 0, textAlign: 'center', fontSize: 13, color: '#484f58' },
  link:      { color: '#388bfd', textDecoration: 'none' },
};
