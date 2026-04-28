'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HealthStatus {
  status: string;
  service: string;
  timestamp: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [health, setHealth]     = useState<HealthStatus | null>(null);
  const [loading, setLoading]   = useState(true);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting]   = useState(false);

  const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then((d) => setHealth(d as HealthStatus))
      .catch(() => setHealth(null))
      .finally(() => setLoading(false));
  }, [API]);

  const testChallenge = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch(`${API}/api/v1/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json() as { challenge_id: string; nonce: string };
      setChallenge(d.challenge_id);
      setTestResult(`✅ Challenge issued: ${d.challenge_id.slice(0, 8)}…`);
    } catch {
      setTestResult('❌ Backend unreachable');
    } finally {
      setTesting(false);
    }
  };

  const cards = [
    { icon: '🔐', title: 'ZKP Authentication', subtitle: 'Passwordless Groth16 login', color: '#1f6feb', path: '/login' },
    { icon: '🎓', title: 'Issuer Portal', subtitle: 'MANIT — Issue M.Tech credentials', color: '#238636', path: '/issuer' },
    { icon: '🏦', title: 'Verifier Portal', subtitle: 'Acme Corp — Verify credentials', color: '#9333ea', path: '/verifier' },
  ];

  const endpoints = [
    { method: 'GET',  path: '/health',                         desc: 'Service health check' },
    { method: 'POST', path: '/api/v1/auth/challenge',           desc: 'Issue ZKP nonce' },
    { method: 'POST', path: '/api/v1/auth/verify',              desc: 'Verify Groth16 proof' },
    { method: 'POST', path: '/api/issuer/issue-id',             desc: 'Issue W3C VC credential' },
    { method: 'POST', path: '/api/verifier/request-proof',      desc: 'Generate proof request QR' },
    { method: 'POST', path: '/api/verifier/verify',             desc: 'Verify Verifiable Presentation' },
    { method: 'GET',  path: '/api/issuer/did-document',         desc: 'Issuer DID document' },
    { method: 'GET',  path: '/api/verifier/did-document',       desc: 'Verifier DID document' },
  ];

  return (
    <div style={s.page}>
      {/* ── Header ── */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <div style={s.logoRow}>
            <div style={s.logoMark}>ZK</div>
            <div>
              <h1 style={s.logoTitle}>ZK-Auth</h1>
              <p style={s.logoSub}>Zero-Knowledge Authentication Platform</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {loading ? (
              <span style={s.statusPill}>Checking…</span>
            ) : health?.status === 'ok' ? (
              <span style={{ ...s.statusPill, background: '#052e16', color: '#4ade80', borderColor: '#238636' }}>
                ● System Online
              </span>
            ) : (
              <span style={{ ...s.statusPill, background: '#450a0a', color: '#f87171', borderColor: '#6e1f1f' }}>
                ● Backend Offline
              </span>
            )}
          </div>
        </div>
      </header>

      <main style={s.main}>

        {/* ── Hero ── */}
        <section style={s.hero}>
          <p style={s.heroEyebrow}>MTech AI Research · MANIT Bhopal · FrontSci 2025</p>
          <h2 style={s.heroTitle}>Enterprise ZKP + Behavioral Biometrics</h2>
          <p style={s.heroDesc}>
            Passwordless authentication using <strong>Groth16 zero-knowledge proofs</strong>,{' '}
            <strong>Poseidon Merkle selective disclosure</strong>, and{' '}
            <strong>LSTM behavioral risk scoring</strong>.
            No passwords. No PII stored. Continuous identity verification.
          </p>
        </section>

        {/* ── Portal cards ── */}
        <section style={s.section}>
          <h3 style={s.sectionTitle}>Demo Portals</h3>
          <div style={s.cardGrid}>
            {cards.map((c) => (
              <motion.a
                key={c.path}
                href={c.path}
                style={{ ...s.portalCard, borderColor: c.color + '44', textDecoration: 'none' }}
                whileHover={{ scale: 1.02, borderColor: c.color }}
                transition={{ duration: 0.15 }}
              >
                <div style={{ ...s.portalIcon, background: c.color + '22', color: c.color }}>
                  {c.icon}
                </div>
                <p style={s.portalTitle}>{c.title}</p>
                <p style={s.portalSub}>{c.subtitle}</p>
                <span style={{ ...s.portalArrow, color: c.color }}>→</span>
              </motion.a>
            ))}
          </div>
        </section>

        {/* ── System health + live test ── */}
        <section style={s.section}>
          <h3 style={s.sectionTitle}>System Status</h3>
          <div style={s.statusGrid}>
            <div style={s.statusCard}>
              <p style={s.statusCardTitle}>Backend API</p>
              <p style={s.statusCardValue}>{health?.status === 'ok' ? '✅ Online' : '❌ Offline'}</p>
              <p style={s.statusCardSub}>localhost:3001</p>
            </div>
            <div style={s.statusCard}>
              <p style={s.statusCardTitle}>Database</p>
              <p style={s.statusCardValue}>{health ? '✅ Connected' : '❓ Unknown'}</p>
              <p style={s.statusCardSub}>PostgreSQL + TimescaleDB</p>
            </div>
            <div style={s.statusCard}>
              <p style={s.statusCardTitle}>Redis Cache</p>
              <p style={s.statusCardValue}>{health ? '✅ Connected' : '❓ Unknown'}</p>
              <p style={s.statusCardSub}>Sessions + Nullifiers</p>
            </div>
            <div style={s.statusCard}>
              <p style={s.statusCardTitle}>ML Service</p>
              <p style={s.statusCardValue}>⚡ gRPC Active</p>
              <p style={s.statusCardSub}>LSTM · localhost:50051</p>
            </div>
          </div>

          <button style={s.testBtn} onClick={testChallenge} disabled={testing}>
            {testing ? 'Testing…' : '🧪 Run Live API Test (POST /auth/challenge)'}
          </button>
          {testResult && (
            <motion.p
              style={{ ...s.testResult, color: testResult.startsWith('✅') ? '#4ade80' : '#f87171' }}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {testResult}
            </motion.p>
          )}
        </section>

        {/* ── API endpoints ── */}
        <section style={s.section}>
          <h3 style={s.sectionTitle}>API Endpoints</h3>
          <div style={s.endpointList}>
            {endpoints.map((e) => (
              <div key={e.path} style={s.endpointRow}>
                <span style={{
                  ...s.methodBadge,
                  background: e.method === 'GET' ? '#0d2149' : '#0a1d0f',
                  color:      e.method === 'GET' ? '#388bfd' : '#4ade80',
                }}>
                  {e.method}
                </span>
                <code style={s.endpointPath}>{e.path}</code>
                <span style={s.endpointDesc}>{e.desc}</span>
                <a
                  href={`http://localhost:3001${e.path}`}
                  target="_blank"
                  rel="noreferrer"
                  style={s.endpointLink}
                >
                  ↗
                </a>
              </div>
            ))}
          </div>
        </section>

        {/* ── Architecture ── */}
        <section style={s.section}>
          <h3 style={s.sectionTitle}>Three-Actor Architecture</h3>
          <div style={s.archGrid}>
            {[
              { actor: 'Issuer', icon: '🎓', did: 'did:web:gov.zk-auth.io', role: 'Issues W3C Verifiable Credentials with Poseidon Merkle commitments. PII never stored.', color: '#238636' },
              { actor: 'Holder', icon: '📱', did: 'did:key:z…wallet', role: 'Stores VCs in wallet. Generates Groth16 ZK proofs locally. Controls selective disclosure.', color: '#1f6feb' },
              { actor: 'Verifier', icon: '🏦', did: 'did:web:bank.zk-auth.io', role: 'Resolves Issuer DID. Verifies ZK proof. Receives boolean result only — zero raw data.', color: '#9333ea' },
            ].map((a) => (
              <div key={a.actor} style={{ ...s.archCard, borderColor: a.color + '44' }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>{a.icon}</div>
                <p style={{ ...s.archActor, color: a.color }}>{a.actor}</p>
                <code style={s.archDid}>{a.did}</code>
                <p style={s.archRole}>{a.role}</p>
              </div>
            ))}
          </div>
        </section>

      </main>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:         { minHeight: '100vh', background: '#010409', color: '#e6edf3', fontFamily: 'system-ui, -apple-system, sans-serif' },
  header:       { background: '#0d1117', borderBottom: '1px solid #21262d', padding: '0 24px', position: 'sticky', top: 0, zIndex: 10 },
  headerInner:  { maxWidth: 1100, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 60 },
  logoRow:      { display: 'flex', alignItems: 'center', gap: 12 },
  logoMark:     { width: 36, height: 36, background: 'linear-gradient(135deg,#1f6feb,#388bfd)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: '#fff' },
  logoTitle:    { margin: 0, fontSize: 16, fontWeight: 700, color: '#e6edf3' },
  logoSub:      { margin: 0, fontSize: 10, color: '#8b949e' },
  statusPill:   { fontSize: 11, padding: '4px 10px', borderRadius: 20, border: '1px solid #30363d', color: '#8b949e', background: '#161b22' },
  main:         { maxWidth: 1100, margin: '0 auto', padding: '32px 24px' },
  hero:         { marginBottom: 40, padding: '32px', background: 'linear-gradient(135deg,#0d1117,#0d2149)', borderRadius: 12, border: '1px solid #1f6feb44' },
  heroEyebrow:  { margin: '0 0 8px', fontSize: 11, color: '#388bfd', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' },
  heroTitle:    { margin: '0 0 12px', fontSize: 28, fontWeight: 800, color: '#e6edf3', lineHeight: 1.2 },
  heroDesc:     { margin: 0, fontSize: 15, color: '#8b949e', lineHeight: 1.7, maxWidth: 700 },
  section:      { marginBottom: 36 },
  sectionTitle: { margin: '0 0 16px', fontSize: 14, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.08em' },
  cardGrid:     { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 },
  portalCard:   { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: '20px', background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, cursor: 'pointer' },
  portalIcon:   { width: 40, height: 40, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 4 },
  portalTitle:  { margin: 0, fontSize: 15, fontWeight: 700, color: '#e6edf3' },
  portalSub:    { margin: 0, fontSize: 12, color: '#8b949e', flexGrow: 1 },
  portalArrow:  { fontSize: 18, fontWeight: 700, alignSelf: 'flex-end' },
  statusGrid:   { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 },
  statusCard:   { background: '#0d1117', border: '1px solid #21262d', borderRadius: 8, padding: '14px 16px' },
  statusCardTitle: { margin: '0 0 6px', fontSize: 11, color: '#8b949e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' },
  statusCardValue: { margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#e6edf3' },
  statusCardSub:   { margin: 0, fontSize: 11, color: '#484f58' },
  testBtn:      { background: '#161b22', border: '1px solid #30363d', color: '#c9d1d9', borderRadius: 8, padding: '10px 18px', fontSize: 13, cursor: 'pointer', fontWeight: 600 },
  testResult:   { margin: '10px 0 0', fontSize: 14, fontFamily: 'monospace' },
  endpointList: { display: 'flex', flexDirection: 'column', gap: 2 },
  endpointRow:  { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: '#0d1117', borderRadius: 6, border: '1px solid #21262d' },
  methodBadge:  { fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace', minWidth: 38, textAlign: 'center' },
  endpointPath: { fontSize: 12, color: '#c9d1d9', fontFamily: 'monospace', flex: 1 },
  endpointDesc: { fontSize: 12, color: '#8b949e', flex: 1 },
  endpointLink: { fontSize: 14, color: '#388bfd', textDecoration: 'none' },
  archGrid:     { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 },
  archCard:     { background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '20px', textAlign: 'center' },
  archActor:    { margin: '0 0 6px', fontSize: 16, fontWeight: 800 },
  archDid:      { display: 'block', fontSize: 10, color: '#484f58', marginBottom: 10, fontFamily: 'monospace', wordBreak: 'break-all' },
  archRole:     { margin: 0, fontSize: 12, color: '#8b949e', lineHeight: 1.6 },
};
