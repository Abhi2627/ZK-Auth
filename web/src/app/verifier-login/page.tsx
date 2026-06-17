'use client';

/**
 * Verifier Login Page - Corporate HR / Bank Verification Portal Auth
 *
 * The Verifier is an institutional actor (Acme Corp HR, bank, etc.).
 * Security model: API key auth tied to the verifier's DID.
 * API key is stored in sessionStorage for the session.
 *
 * In production: OAuth2 client_credentials flow with the verifier's
 * DID as the client_id. For demo/paper: API key is sufficient.
 *
 * Access level: VERIFIER_INSTITUTION
 * Portal: /verifier (protected)
 */

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

const DEMO_VERIFIERS = [
  { name: 'Acme Corp HR Portal',  did: 'did:web:bank.zk-auth.io',    key: 'demo_verifier_acme_key_32chars_minimum' },
  { name: 'State Bank of India',  did: 'did:web:sbi.zk-auth.io',     key: 'demo_verifier_sbi_key_32chars_minimum_x' },
  { name: 'TechCorp Engineering', did: 'did:web:techcorp.zk-auth.io', key: 'demo_verifier_tech_key_32chars_minimum_' },
];

export default function VerifierLoginPage() {
  const [apiKey, setApiKey]     = useState('');
  const [orgName, setOrgName]   = useState('');
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const router = useRouter();

  const handleLogin = async () => {
    if (!apiKey.trim()) { setError('Enter your verifier API key.'); return; }
    setLoading(true);
    setError(null);

    try {
      const r = await fetch(`${API}/api/verifier/verify-apikey`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });

      if (!r.ok) {
        const d = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(d.message ?? 'Invalid API key');
      }

      const data = await r.json() as { verifier_did: string; org_name: string };
      sessionStorage.setItem('verifier_api_key', apiKey.trim());
      sessionStorage.setItem('verifier_did', data.verifier_did);
      sessionStorage.setItem('verifier_org', data.org_name);
      router.push('/verifier');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const fillDemo = (v: typeof DEMO_VERIFIERS[0]) => {
    setApiKey(v.key);
    setOrgName(v.name);
    setError(null);
  };

  return (
    <div style={s.page}>
      <div style={s.card}>
        {/* Header */}
        <div style={s.header}>
          <span style={s.icon}>🏦</span>
          <div>
            <h1 style={s.title}>Verifier Portal</h1>
            <p style={s.subtitle}>ZK-Auth Credential Verification Gateway</p>
          </div>
        </div>

        <div style={s.divider} />

        <p style={s.desc}>
          This portal is for <strong>registered verifier institutions</strong> (HR portals,
          banks, government agencies) authorised to request ZK credential proofs from holders.
          Authenticate with your verifier API key.
        </p>

        {/* Role badge */}
        <div style={s.roleBadge}>
          <span>🔍</span>
          <span>Access Level: <strong>VERIFIER_INSTITUTION</strong></span>
        </div>

        {/* Demo quick-fill */}
        <div style={s.demoSection}>
          <p style={s.demoTitle}>Demo Verifiers (click to fill)</p>
          <div style={s.demoGrid}>
            {DEMO_VERIFIERS.map((v) => (
              <button key={v.did} style={s.demoBtn} onClick={() => fillDemo(v)}>
                {v.name}
              </button>
            ))}
          </div>
        </div>

        {/* API Key input */}
        <div style={s.fieldGroup}>
          <label style={s.label}>Verifier API Key</label>
          <input
            type="password"
            placeholder="vk_live_..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            style={s.input}
          />
        </div>

        {orgName && (
          <div style={s.selectedOrg}>
            <span>Selected: <strong>{orgName}</strong></span>
          </div>
        )}

        {error && <div style={s.error}>{error}</div>}

        <button
          style={{ ...s.btn, opacity: loading ? 0.6 : 1 }}
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? 'Authenticating...' : '🔍 Access Verifier Portal'}
        </button>

        {/* Architecture note */}
        <div style={s.infoBox}>
          <p style={s.infoTitle}>Verifier Security Model</p>
          <p style={s.infoText}>
            Verifiers authenticate using <strong>API keys tied to their DID</strong>
            (Decentralized Identifier). Once authenticated, they can request
            selective disclosure proofs from holders. The verifier receives only
            boolean results — <em>never</em> raw PII. In production, this would use
            OAuth2 client_credentials with the verifier's DID as client_id.
          </p>
        </div>

        <p style={s.footer}>
          Not a verifier?&nbsp;
          <a href="/login" style={s.link}>Holder login</a>
          &nbsp;|&nbsp;
          <a href="/issuer-login" style={s.link}>Issuer portal</a>
        </p>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page:        { minHeight: '100vh', background: '#010409', display: 'flex', alignItems: 'center',
                 justifyContent: 'center', fontFamily: 'system-ui, sans-serif', padding: 24 },
  card:        { background: '#0d1117', border: '1px solid #21262d', borderRadius: 14,
                 padding: 36, width: '100%', maxWidth: 480 },
  header:      { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 },
  icon:        { fontSize: 44 },
  title:       { margin: 0, fontSize: 22, fontWeight: 800, color: '#e6edf3' },
  subtitle:    { margin: 0, fontSize: 12, color: '#8b949e' },
  divider:     { height: 1, background: '#21262d', margin: '0 0 20px' },
  desc:        { fontSize: 13, color: '#8b949e', lineHeight: 1.6, margin: '0 0 16px' },
  roleBadge:   { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                 background: '#0d1a2d', border: '1px solid #1f6feb44', borderRadius: 8,
                 fontSize: 13, color: '#79c0ff', marginBottom: 20 },
  demoSection: { background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
                 padding: '12px 14px', marginBottom: 18 },
  demoTitle:   { margin: '0 0 10px', fontSize: 11, color: '#8b949e',
                 fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' },
  demoGrid:    { display: 'flex', flexDirection: 'column', gap: 6 },
  demoBtn:     { background: '#0d1117', border: '1px solid #30363d', borderRadius: 6,
                 color: '#c9d1d9', padding: '7px 12px', fontSize: 13, cursor: 'pointer',
                 textAlign: 'left' },
  fieldGroup:  { marginBottom: 14 },
  label:       { display: 'block', fontSize: 11, color: '#8b949e', marginBottom: 6,
                 fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' },
  input:       { width: '100%', background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
                 color: '#e6edf3', padding: '10px 12px', fontSize: 14, boxSizing: 'border-box',
                 fontFamily: 'monospace' },
  selectedOrg: { background: '#052e16', border: '1px solid #238636', borderRadius: 6,
                 padding: '7px 12px', fontSize: 13, color: '#4ade80', marginBottom: 12 },
  error:       { background: '#1a0505', border: '1px solid #6e1f1f', borderRadius: 8,
                 color: '#f87171', fontSize: 13, padding: '10px 12px', marginBottom: 14 },
  btn:         { width: '100%', background: 'linear-gradient(135deg, #1f6feb, #388bfd)',
                 border: 'none', color: '#fff', borderRadius: 8, padding: '13px',
                 fontSize: 15, fontWeight: 700, cursor: 'pointer', marginBottom: 20 },
  infoBox:     { background: '#0d1a2d', border: '1px solid #1f3a5f44', borderRadius: 8,
                 padding: '14px 16px', marginBottom: 16 },
  infoTitle:   { margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#79c0ff' },
  infoText:    { margin: 0, fontSize: 12, color: '#8b949e', lineHeight: 1.5 },
  footer:      { margin: 0, textAlign: 'center', fontSize: 13, color: '#484f58' },
  link:        { color: '#388bfd', textDecoration: 'none' },
};
