'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { getAccessToken } from '../../lib/api';
import { BehavioralAuthDemo } from '../../components/BehavioralAuthDemo';
import { CredentialWallet }   from '../../components/CredentialWallet';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

async function apiAuth(path: string, body?: object) {
  const token = getAccessToken();
  const r = await fetch(`${API}${path}`, {
    method:  body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

type Tab = 'overview' | 'wallet' | 'behavioral';

export default function DashboardPage() {
  const [health, setHealth]       = useState<{ status: string } | null>(null);
  const [loading, setLoading]     = useState(true);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting]     = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  useEffect(() => {
    fetch(`${API}/health`)
      .then(r => r.json())
      .then(d => setHealth(d as { status: string }))
      .catch(() => setHealth(null))
      .finally(() => setLoading(false));
  }, []);

  const testChallenge = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const d = await apiAuth('/api/v1/auth/challenge', {}) as { challenge_id: string };
      setTestResult(`✅ Challenge issued: ${d.challenge_id?.slice(0, 8) ?? '?'}…`);
    } catch {
      setTestResult('❌ Backend unreachable');
    } finally {
      setTesting(false);
    }
  };

  const online = health?.status === 'ok';

  const portalCards = [
    { icon: '🎓', title: 'Issuer Portal',    subtitle: 'Issue credentials as a registered institute', color: '#238636', path: '/issuer-login' },
    { icon: '🔍', title: 'Verifier Portal',  subtitle: 'Verify ZK proofs from credential holders',   color: '#9333ea', path: '/verifier-login' },
    { icon: '🌐', title: 'ZK-Auth Platform', subtitle: 'Register your institute — get your DID',     color: '#f0883e', path: '/platform' },
  ];

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview',   label: '🏠 Overview' },
    { id: 'wallet',     label: '🔐 ZK Wallet' },
    { id: 'behavioral', label: '🧠 Behavioral Auth' },
  ];

  return (
    <div style={s.page}>

      {/* Header */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <div style={s.logoRow}>
            <div style={s.logoMark}>ZK</div>
            <div>
              <h1 style={s.logoTitle}>ZK-Auth</h1>
              <p style={s.logoSub}>Holder Dashboard</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {loading ? (
              <span style={s.pill}>Checking…</span>
            ) : online ? (
              <span style={{ ...s.pill, background: '#052e16', color: '#4ade80', borderColor: '#238636' }}>
                ● System Online
              </span>
            ) : (
              <span style={{ ...s.pill, background: '#450a0a', color: '#f87171', borderColor: '#6e1f1f' }}>
                ● Backend Offline
              </span>
            )}
            <a href="/login" style={{ fontSize: 12, color: '#8b949e', textDecoration: 'none' }}>
              ← Login
            </a>
          </div>
        </div>
      </header>

      <main style={s.main}>

        {/* Hero */}
        <section style={s.hero}>
          <p style={s.eyebrow}>ZK-Auth Platform · M.Tech AI Research · MANIT Bhopal · FrontSci 2025</p>
          <h2 style={s.heroTitle}>ZK-Auth — Holder Dashboard</h2>
          <p style={s.heroDesc}>
            Passwordless authentication with <strong>Groth16 ZK-SNARKs</strong>,{' '}
            <strong>Poseidon Merkle selective disclosure</strong>, and{' '}
            <strong>LSTM behavioral biometric monitoring</strong>.
            No passwords. No PII stored server-side. Continuous identity verification.
          </p>
        </section>

        {/* Tab bar */}
        <div style={s.tabBar}>
          {tabs.map(t => (
            <button
              key={t.id}
              style={{ ...s.tabBtn, ...(activeTab === t.id ? s.tabBtnActive : {}) }}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ─── OVERVIEW TAB ─────────────────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div>
            {/* Portal cards */}
            <section style={s.section}>
              <h3 style={s.sectionTitle}>Portals</h3>
              <div style={s.cardGrid}>
                {portalCards.map(c => (
                  <motion.a key={c.path} href={c.path}
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

            {/* System status */}
            <section style={s.section}>
              <h3 style={s.sectionTitle}>System Status</h3>
              <div style={s.statusGrid}>
                {[
                  { title: 'Backend API',     value: online ? '✅ Online'     : '❌ Offline',   sub: 'localhost:3001' },
                  { title: 'PostgreSQL',      value: online ? '✅ Connected'  : '❓ Unknown',   sub: 'Port 5432' },
                  { title: 'Redis',           value: online ? '✅ Connected'  : '❓ Unknown',   sub: 'Sessions + Nullifiers' },
                  { title: 'LSTM ML Service', value: '⚡ gRPC :50051',                         sub: 'Behavioral scoring' },
                ].map(card => (
                  <div key={card.title} style={s.statusCard}>
                    <p style={s.statusCardTitle}>{card.title}</p>
                    <p style={s.statusCardValue}>{card.value}</p>
                    <p style={s.statusCardSub}>{card.sub}</p>
                  </div>
                ))}
              </div>
              <button style={s.testBtn} onClick={testChallenge} disabled={testing}>
                {testing ? 'Testing…' : '🧪 Live API Test — POST /auth/challenge'}
              </button>
              {testResult && (
                <p style={{ ...s.testResult, color: testResult.startsWith('✅') ? '#4ade80' : '#f87171' }}>
                  {testResult}
                </p>
              )}
            </section>

            {/* Three-actor architecture */}
            <section style={s.section}>
              <h3 style={s.sectionTitle}>Three-Actor ZK Ecosystem</h3>
              <div style={s.archGrid}>
                {[
                  { actor: 'Issuer',   icon: '🎓', did: 'did:web:institute.zk-auth.io', color: '#238636',
                    role: 'Any registered institute. Issues W3C VCs signed with their Ed25519 key. Raw PII never stored — only Poseidon Merkle roots.' },
                  { actor: 'Holder',   icon: '📱', did: 'did:key:z…wallet',             color: '#1f6feb',
                    role: 'You. Stores credentials in ZK wallet. Generates Groth16 proofs locally. Controls what to share and with whom.' },
                  { actor: 'Verifier', icon: '🔍', did: 'did:web:verifier.zk-auth.io',  color: '#9333ea',
                    role: 'Bank, employer, govt. Resolves issuer DID. Verifies ZK proof. Receives boolean only — never raw attribute values.' },
                ].map(a => (
                  <div key={a.actor} style={{ ...s.archCard, borderColor: a.color + '44' }}>
                    <div style={{ fontSize: 32, marginBottom: 10 }}>{a.icon}</div>
                    <p style={{ ...s.archActor, color: a.color }}>{a.actor}</p>
                    <code style={s.archDid}>{a.did}</code>
                    <p style={s.archRole}>{a.role}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* ─── ZK WALLET TAB ────────────────────────────────────────────────── */}
        {activeTab === 'wallet' && (
          <section style={s.section}>
            <CredentialWallet />
          </section>
        )}

        {/* ─── BEHAVIORAL AUTH TAB ──────────────────────────────────────────── */}
        {activeTab === 'behavioral' && (
          <section style={s.section}>
            <h3 style={s.sectionTitle}>🧠 Live LSTM Behavioral Authentication Demo</h3>
            <BehavioralAuthDemo />
          </section>
        )}

      </main>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page:            { minHeight: '100vh', background: '#010409', color: '#e6edf3',
                     fontFamily: 'system-ui, -apple-system, sans-serif' },
  header:          { background: '#0d1117', borderBottom: '1px solid #21262d', padding: '0 24px',
                     position: 'sticky', top: 0, zIndex: 10 },
  headerInner:     { maxWidth: 1100, margin: '0 auto', display: 'flex', justifyContent: 'space-between',
                     alignItems: 'center', height: 60 },
  logoRow:         { display: 'flex', alignItems: 'center', gap: 12 },
  logoMark:        { width: 36, height: 36, background: 'linear-gradient(135deg,#1f6feb,#388bfd)',
                     borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                     fontSize: 14, fontWeight: 800, color: '#fff' },
  logoTitle:       { margin: 0, fontSize: 16, fontWeight: 700, color: '#e6edf3' },
  logoSub:         { margin: 0, fontSize: 10, color: '#8b949e' },
  pill:            { fontSize: 11, padding: '4px 10px', borderRadius: 20, border: '1px solid #30363d',
                     color: '#8b949e', background: '#161b22' },
  main:            { maxWidth: 1100, margin: '0 auto', padding: '32px 24px' },
  hero:            { marginBottom: 24, padding: '28px 32px',
                     background: 'linear-gradient(135deg,#0d1117,#0d2149)',
                     borderRadius: 12, border: '1px solid #1f6feb44' },
  eyebrow:         { margin: '0 0 8px', fontSize: 11, color: '#388bfd', fontWeight: 600,
                     textTransform: 'uppercase', letterSpacing: '0.08em' },
  heroTitle:       { margin: '0 0 10px', fontSize: 26, fontWeight: 800, color: '#e6edf3' },
  heroDesc:        { margin: 0, fontSize: 14, color: '#8b949e', lineHeight: 1.7, maxWidth: 700 },
  // Tab bar
  tabBar:          { display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid #21262d' },
  tabBtn:          { background: 'none', border: 'none', borderBottom: '2px solid transparent',
                     color: '#8b949e', padding: '10px 20px', fontSize: 14, cursor: 'pointer',
                     fontWeight: 600, marginBottom: -1, transition: 'color 0.15s' },
  tabBtnActive:    { color: '#e6edf3', borderBottomColor: '#388bfd' },
  section:         { marginBottom: 32 },
  sectionTitle:    { margin: '0 0 14px', fontSize: 13, fontWeight: 700, color: '#8b949e',
                     textTransform: 'uppercase', letterSpacing: '0.08em' },
  cardGrid:        { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 },
  portalCard:      { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6,
                     padding: '18px', background: '#0d1117', border: '1px solid #21262d',
                     borderRadius: 10, cursor: 'pointer' },
  portalIcon:      { width: 38, height: 38, borderRadius: 8, display: 'flex', alignItems: 'center',
                     justifyContent: 'center', fontSize: 18, marginBottom: 4 },
  portalTitle:     { margin: 0, fontSize: 14, fontWeight: 700, color: '#e6edf3' },
  portalSub:       { margin: 0, fontSize: 12, color: '#8b949e', flexGrow: 1 },
  portalArrow:     { fontSize: 16, fontWeight: 700, alignSelf: 'flex-end' },
  statusGrid:      { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 },
  statusCard:      { background: '#0d1117', border: '1px solid #21262d', borderRadius: 8,
                     padding: '12px 14px' },
  statusCardTitle: { margin: '0 0 4px', fontSize: 10, color: '#8b949e', fontWeight: 700,
                     textTransform: 'uppercase', letterSpacing: '0.06em' },
  statusCardValue: { margin: '0 0 3px', fontSize: 14, fontWeight: 700, color: '#e6edf3' },
  statusCardSub:   { margin: 0, fontSize: 10, color: '#484f58' },
  testBtn:         { background: '#161b22', border: '1px solid #30363d', color: '#c9d1d9',
                     borderRadius: 8, padding: '9px 16px', fontSize: 13, cursor: 'pointer',
                     fontWeight: 600 },
  testResult:      { margin: '8px 0 0', fontSize: 13, fontFamily: 'monospace' },
  archGrid:        { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 },
  archCard:        { background: '#0d1117', border: '1px solid', borderRadius: 10,
                     padding: '18px', textAlign: 'center' },
  archActor:       { margin: '0 0 5px', fontSize: 15, fontWeight: 800 },
  archDid:         { display: 'block', fontSize: 9, color: '#484f58', marginBottom: 8,
                     fontFamily: 'monospace', wordBreak: 'break-all' },
  archRole:        { margin: 0, fontSize: 11, color: '#8b949e', lineHeight: 1.5 },
};
