/**
 * Issuer Demo Portal — MANIT University Admin Dashboard
 *
 * Demonstrates the Issuer actor in the three-actor ZK ecosystem.
 * Non-cryptographer friendly: visually shows raw PII → Poseidon hashing →
 * Merkle tree construction → W3C VC output at each step.
 *
 * Flow:
 *   1. Admin fills student details form
 *   2. Click "Issue M.Tech ZK-Credential"
 *   3. Animated pipeline: Raw PII → Attribute Encoding → Poseidon Hashing
 *      → Merkle Tree Build → W3C VC Envelope → QR Code
 *   4. QR displayed — student scans into wallet
 */

'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence }       from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'issue' | 'history' | 'behavioral';

type PipelineStep =
  | 'idle'
  | 'encoding'
  | 'hashing'
  | 'building_tree'
  | 'wrapping_vc'
  | 'complete'
  | 'error';

interface AttributeRow {
  name:       string;
  raw:        string;
  encoded:    string | null;
  leafHash:   string | null;
}

interface IssuanceResult {
  credential_id:         string;
  verifiable_credential: Record<string, unknown>;
  merkle_root:           string;
  attribute_schema:      string[];
  salts:                 Record<string, string>;
  leaf_hashes:           Record<string, string>;
  issued_at:             string;
  expires_at:            string;
}

interface HistoryRecord {
  id:              string;
  credential_id:   string;
  credential_type: string;
  holder_did:      string;
  issued_at:       string;
  expires_at:      string | null;
  merkle_root:     string;
  attributes:      string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

const PIPELINE_STEPS: { key: PipelineStep; label: string; icon: string }[] = [
  { key: 'encoding',      label: 'Encoding Attributes',        icon: '🔢' },
  { key: 'hashing',       label: 'Poseidon Hash Each Leaf',    icon: '🌿' },
  { key: 'building_tree', label: 'Building Merkle Tree',       icon: '🌳' },
  { key: 'wrapping_vc',   label: 'Wrapping W3C VC Envelope',   icon: '📋' },
  { key: 'complete',      label: 'Credential Issued',          icon: '✅' },
];

// ─── QR renderer (dynamic import of qrcode) ───────────────────────────────────

function QRCodeDisplay({ data }: { data: string }) {
  const [src, setSrc] = useState<string | null>(null);

  React.useEffect(() => {
    import('qrcode').then(({ default: QRCode }) => {
      QRCode.toDataURL(data, { errorCorrectionLevel: 'M', width: 260, margin: 2 })
        .then(setSrc)
        .catch(() => setSrc(null));
    }).catch(() => setSrc(null));
  }, [data]);

  if (!src) return <p style={s.qrFallback}>Install qrcode to see QR: <code style={s.code}>npm install qrcode @types/qrcode</code></p>;
  return <img src={src} alt="Verifiable Credential QR Code" style={s.qrImg} />;
}

// ─── Merkle Tree Visualiser ────────────────────────────────────────────────────

function MerkleTreeVisual({ leaves, root }: { leaves: AttributeRow[]; root: string }) {
  const activeLeavesCount = leaves.filter((l) => l.leafHash).length;

  return (
    <div style={s.treeContainer}>
      <p style={s.treeTitle}>Poseidon Merkle Tree</p>

      {/* Root */}
      <div style={s.treeRow}>
        <motion.div
          style={s.treeNode}
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.4, type: 'spring' }}
        >
          <p style={s.treeNodeLabel}>ROOT</p>
          <code style={s.treeNodeHash}>{root ? truncHash(root) : '…'}</code>
        </motion.div>
      </div>

      {/* Connector */}
      <div style={s.treeLine} aria-hidden="true" />

      {/* Leaves */}
      <div style={s.leafRow}>
        {leaves.map((leaf, i) => (
          <motion.div
            key={leaf.name}
            style={{
              ...s.leafNode,
              borderColor: leaf.leafHash ? '#4ade80' : '#21262d',
              background:  leaf.leafHash ? '#0a1d0f' : '#0d1117',
            }}
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: leaf.leafHash ? 1 : 0.4 }}
            transition={{ delay: i * 0.12, duration: 0.3 }}
          >
            <p style={s.leafLabel}>{formatAttr(leaf.name)}</p>
            {leaf.raw && (
              <p style={s.leafRaw}>
                <span style={s.rawBadge}>RAW</span> {leaf.raw}
              </p>
            )}
            {leaf.encoded && (
              <p style={s.leafEncoded}>
                <span style={s.encBadge}>ENC</span> <code>{leaf.encoded}</code>
              </p>
            )}
            {leaf.leafHash && (
              <p style={s.leafHash}>
                <span style={s.hashBadge}>H</span>
                <code style={s.hashCode}>{truncHash(leaf.leafHash)}</code>
              </p>
            )}
          </motion.div>
        ))}
      </div>

      {/* Progress indicator */}
      <p style={s.treeProgress}>
        {activeLeavesCount} / {leaves.length} leaves hashed
      </p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function IssuerDemoPage() {
  const [form, setForm] = useState({
    full_name:      '',
    date_of_birth:  '',
    enrollment_no:  '',
    degree:         'M.Tech AI',
    grad_year:      '2026',
    nationality:    'IN',
  });

  const [step, setStep]         = useState<PipelineStep>('idle');
  const [attributes, setAttributes] = useState<AttributeRow[]>([]);
  const [merkleRoot, setMerkleRoot] = useState('');
  const [result, setResult]     = useState<IssuanceResult | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [vcJson, setVcJson]     = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('issue');
  const [history, setHistory]   = useState<HistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/issuer/history`);
      const d = await r.json() as { records: HistoryRecord[] };
      setHistory(d.records ?? []);
    } catch { /* ignore */ } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'history') fetchHistory();
  }, [activeTab, fetchHistory]);

  const handleChange = (field: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleIssue = useCallback(async () => {
    if (!form.full_name || !form.date_of_birth || !form.enrollment_no) {
      setError('Please fill all required fields');
      return;
    }
    setError(null);
    setResult(null);
    setMerkleRoot('');

    // ── Build attribute display rows ──────────────────────────────────────
    const attrRows: AttributeRow[] = [
      { name: 'full_name',   raw: form.full_name,      encoded: null, leafHash: null },
      { name: 'dob',         raw: form.date_of_birth,  encoded: null, leafHash: null },
      { name: 'id_number',   raw: form.enrollment_no,  encoded: null, leafHash: null },
      { name: 'degree',      raw: form.degree,          encoded: null, leafHash: null },
      { name: 'grad_year',   raw: form.grad_year,       encoded: null, leafHash: null },
      { name: 'nationality', raw: form.nationality,     encoded: null, leafHash: null },
    ];
    setAttributes(attrRows);

    try {
      // ── Step 1: Encoding animation ────────────────────────────────────────
      setStep('encoding');
      await sleep(700);
      setAttributes((prev) => prev.map((a, i) => ({
        ...a,
        encoded: ['crc32(…)', form.date_of_birth.replace(/-/g, ''), 'crc32(…)', '3', form.grad_year, '356'][i] ?? '?',
      })));

      // ── Step 2: Hashing animation ─────────────────────────────────────────
      await sleep(600);
      setStep('hashing');

      // ── Step 3: Build Merkle tree animation ───────────────────────────────
      await sleep(800);
      setStep('building_tree');

      // ── Step 4: Call API ───────────────────────────────────────────────────
      await sleep(400);
      setStep('wrapping_vc');

      const mockDid = `did:key:z${btoa(form.enrollment_no).slice(0, 32)}`;

      const resp = await fetch(`${API_BASE}/api/issuer/issue-id`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holder_did:     mockDid,
          full_name:      form.full_name,
          date_of_birth:  form.date_of_birth,
          id_number:      form.enrollment_no,
          nationality:    form.nationality,
          validity_years: 5,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ message: resp.statusText }));
        throw new Error((err as { message?: string }).message ?? 'Issuance failed');
      }

      const data = (await resp.json()) as IssuanceResult;

      // ── Update attribute rows with real hashes ────────────────────────────
      const leafHashMap = data.leaf_hashes ?? {};
      const schemaKeys  = data.attribute_schema ?? [];
      setAttributes((prev) => prev.map((a) => {
        const key = schemaKeys.find((k) => k.includes(a.name.split('_')[0] ?? ''));
        return { ...a, leafHash: key ? (leafHashMap[key] ?? null) : null };
      }));
      setMerkleRoot(data.merkle_root ?? '');

      await sleep(500);
      setResult(data);
      setVcJson(JSON.stringify(data.verifiable_credential, null, 2));
      setStep('complete');

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStep('error');
    }
  }, [form]);

  const isPipelineActive = !['idle', 'complete', 'error'].includes(step);
  const activeStepIdx    = PIPELINE_STEPS.findIndex((s) => s.key === step);

  return (
    <div style={s.page}>
      {/* ── Header ── */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <div style={s.logoRow}>
            <span style={s.logoIcon}>🎓</span>
            <div>
              <h1 style={s.logoTitle}>MANIT Bhopal</h1>
              <p style={s.logoSubtitle}>Maulana Azad National Institute of Technology</p>
            </div>
          </div>
          <span style={s.headerBadge}>ZK-Auth Credential Issuer Node</span>
        </div>
      </header>

      <main style={s.main}>
        {/* ── Tab navigation ── */}
        <div style={s.tabBar}>
          {([['issue','🔐 Issue Credential'],['history','📋 Issuance History'],['behavioral','🧠 Behavioral Auth']] as const).map(([tab, label]) => (
            <button key={tab} style={{ ...s.tabBtn, ...(activeTab === tab ? s.tabBtnActive : {}) }}
              onClick={() => setActiveTab(tab)}>{label}</button>
          ))}
        </div>

        {activeTab === 'behavioral' && (
          <div style={s.behavioralPanel}>
            <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700 }}>🧠 LSTM Behavioral Biometrics</h2>
            <p style={{ margin: '0 0 20px', color: '#8b949e', fontSize: 14, lineHeight: 1.6 }}>
              ZK-Auth adds a continuous identity verification layer <em>after</em> the initial ZKP login.
              No PIN, no fingerprint, no face scan — the system learns your unique interaction patterns.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 24 }}>
              {[{icon:'⌨️',title:'Keystroke Dynamics',desc:'Dwell time between keypresses, inter-key intervals. Your typing rhythm is unique as a fingerprint.'},
                {icon:'🖱️',title:'Mouse Biometrics',desc:'Velocity, acceleration, curvature of cursor paths. Even hovering patterns reveal identity.'},
                {icon:'📱',title:'Touch Pressure',desc:'Force applied on mobile touchscreen, swipe velocity, grip angle. Captured at 50Hz.'}]
                .map((item) => (
                  <div key={item.title} style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: 16 }}>
                    <div style={{ fontSize: 28, marginBottom: 10 }}>{item.icon}</div>
                    <p style={{ margin: '0 0 6px', fontWeight: 700, color: '#e6edf3' }}>{item.title}</p>
                    <p style={{ margin: 0, fontSize: 12, color: '#8b949e', lineHeight: 1.5 }}>{item.desc}</p>
                  </div>
                ))}
            </div>
            <div style={{ background: '#0d1117', border: '1px solid #1f6feb44', borderRadius: 12, padding: 20 }}>
              <p style={{ margin: '0 0 12px', fontWeight: 700, color: '#79c0ff', fontSize: 14 }}>📊 LSTM Risk Scoring Pipeline</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {['Raw Events (50Hz)','→','Feature Vector','→','LSTM Model','→','Risk Score [0,1]','→','Action'].map((step, i) => (
                  <span key={i} style={{ background: step === '→' ? 'none' : '#161b22', border: step === '→' ? 'none' : '1px solid #30363d',
                    padding: step === '→' ? '0 4px' : '4px 10px', borderRadius: 6, fontSize: 12,
                    color: step === '→' ? '#484f58' : '#c9d1d9' }}>{step}</span>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 16 }}>
                {[{range:'0.0 – 0.45',label:'LOW RISK',action:'No action — session continues normally',color:'#4ade80',bg:'#052e16'},
                  {range:'0.45 – 0.75',label:'MEDIUM RISK',action:'SOFT step-up: re-authenticate with ZKP proof',color:'#fbbf24',bg:'#1c1408'},
                  {range:'0.75 – 1.0',label:'HIGH RISK',action:'HARD step-up: session locked until re-auth',color:'#f87171',bg:'#450a0a'}]
                  .map((tier) => (
                    <div key={tier.label} style={{ background: tier.bg, border: `1px solid ${tier.color}44`, borderRadius: 8, padding: 12 }}>
                      <p style={{ margin: '0 0 4px', fontSize: 10, fontFamily: 'monospace', color: tier.color }}>{tier.range}</p>
                      <p style={{ margin: '0 0 6px', fontWeight: 700, color: tier.color, fontSize: 13 }}>{tier.label}</p>
                      <p style={{ margin: 0, fontSize: 11, color: '#8b949e', lineHeight: 1.4 }}>{tier.action}</p>
                    </div>
                  ))}
              </div>
              <p style={{ margin: '16px 0 0', fontSize: 12, color: '#484f58' }}>
                ⚡ ML service: gRPC on localhost:50051 · LSTM trained on 50Hz behavioral events · Real-time inference &lt;5ms
              </p>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Credential Issuance History</h2>
              <button style={{ ...s.retryBtn, fontSize: 12 }} onClick={fetchHistory} disabled={historyLoading}>
                {historyLoading ? 'Loading…' : '↻ Refresh'}
              </button>
            </div>
            {historyLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>Loading records…</div>
            ) : history.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 60, color: '#484f58' }}>
                <p style={{ fontSize: 40, margin: '0 0 12px' }}>📋</p>
                <p style={{ margin: 0, fontSize: 16, color: '#8b949e' }}>No credentials issued yet</p>
                <p style={{ margin: '6px 0 0', fontSize: 13 }}>Issue a credential to see it here</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {history.map((rec) => (
                  <div key={rec.id} style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 24 }}>🎓</span>
                        <div>
                          <p style={{ margin: 0, fontWeight: 700, color: '#e6edf3', fontSize: 14 }}>{rec.credential_type}</p>
                          <p style={{ margin: 0, fontSize: 11, color: '#8b949e', fontFamily: 'monospace' }}>{rec.credential_id.substring(0, 8)}…</p>
                        </div>
                      </div>
                      <span style={{ background: '#052e16', color: '#4ade80', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>ISSUED</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                      <div><p style={{ margin: '0 0 2px', fontSize: 10, color: '#484f58' }}>ISSUED AT</p><p style={{ margin: 0, fontSize: 12, color: '#c9d1d9' }}>{new Date(rec.issued_at).toLocaleString()}</p></div>
                      <div><p style={{ margin: '0 0 2px', fontSize: 10, color: '#484f58' }}>EXPIRES</p><p style={{ margin: 0, fontSize: 12, color: '#c9d1d9' }}>{rec.expires_at ? new Date(rec.expires_at).toLocaleDateString() : '—'}</p></div>
                      <div><p style={{ margin: '0 0 2px', fontSize: 10, color: '#484f58' }}>MERKLE ROOT</p><p style={{ margin: 0, fontSize: 11, color: '#4ade80', fontFamily: 'monospace' }}>{rec.merkle_root}</p></div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <p style={{ margin: '0 0 4px', fontSize: 10, color: '#484f58' }}>ATTRIBUTES COMMITTED (raw values NOT stored)</p>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {(Array.isArray(rec.attributes) ? rec.attributes : []).map((attr: string) => (
                          <span key={attr} style={{ background: '#161b22', border: '1px solid #30363d', padding: '2px 8px', borderRadius: 4, fontSize: 11, color: '#8b949e' }}>{attr}</span>
                        ))}
                      </div>
                    </div>
                    <div style={{ marginTop: 8, padding: '6px 10px', background: '#0a1d0f', borderRadius: 6 }}>
                      <p style={{ margin: 0, fontSize: 11, color: '#3fb950' }}>🛡 Holder DID: <code style={{ fontFamily: 'monospace' }}>{rec.holder_did.substring(0, 32)}…</code></p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'issue' && (
        <div style={s.grid}>

          {/* ── Left: Form ── */}
          <section style={s.formCard}>
            <h2 style={s.sectionTitle}>Issue M.Tech ZK-Credential</h2>
            <p style={s.sectionSubtitle}>
              Student PII is <strong>never stored</strong> — only Poseidon
              cryptographic commitments are persisted.
            </p>

            {[
              { key: 'full_name',     label: 'Full Name *',          type: 'text',  placeholder: 'Abhay Dandge' },
              { key: 'date_of_birth', label: 'Date of Birth *',      type: 'date',  placeholder: '' },
              { key: 'enrollment_no', label: 'Enrollment Number *',  type: 'text',  placeholder: '2023MTECH1234' },
            ].map(({ key, label, type, placeholder }) => (
              <div key={key} style={s.fieldGroup}>
                <label style={s.label}>{label}</label>
                <input
                  type={type}
                  placeholder={placeholder}
                  value={form[key as keyof typeof form]}
                  onChange={handleChange(key)}
                  style={s.input}
                  disabled={isPipelineActive}
                />
              </div>
            ))}

            <div style={s.row2}>
              <div style={s.fieldGroup}>
                <label style={s.label}>Degree</label>
                <select value={form.degree} onChange={handleChange('degree')} style={s.input} disabled={isPipelineActive}>
                  <option>M.Tech AI</option>
                  <option>M.Tech CS</option>
                  <option>M.Tech ECE</option>
                  <option>B.Tech CS</option>
                </select>
              </div>
              <div style={s.fieldGroup}>
                <label style={s.label}>Graduation Year</label>
                <select value={form.grad_year} onChange={handleChange('grad_year')} style={s.input} disabled={isPipelineActive}>
                  {[2024, 2025, 2026, 2027].map((y) => <option key={y}>{y}</option>)}
                </select>
              </div>
            </div>

            {error && (
              <div style={s.errorBox} role="alert">{error}</div>
            )}

            <button
              style={{ ...s.issueBtn, opacity: isPipelineActive ? 0.6 : 1 }}
              onClick={handleIssue}
              disabled={isPipelineActive}
            >
              {isPipelineActive ? '⚙️  Processing…' : '🔐  Issue M.Tech ZK-Credential'}
            </button>

            {/* Pipeline progress */}
            {step !== 'idle' && (
              <div style={s.pipeline}>
                {PIPELINE_STEPS.map((ps, i) => (
                  <div key={ps.key} style={s.pipelineStep}>
                    <motion.div
                      style={{
                        ...s.pipelineDot,
                        background:
                          i < activeStepIdx || step === 'complete'  ? '#238636' :
                          i === activeStepIdx                        ? '#1f6feb' : '#21262d',
                        borderColor:
                          i === activeStepIdx && step !== 'complete' ? '#388bfd' : 'transparent',
                      }}
                      animate={i === activeStepIdx && step !== 'complete' ? { scale: [1, 1.3, 1] } : {}}
                      transition={{ repeat: Infinity, duration: 1 }}
                    >
                      {i < activeStepIdx || step === 'complete' ? '✓' : ps.icon}
                    </motion.div>
                    <p style={s.pipelineLabel}>{ps.label}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Right: Visual pipeline ── */}
          <section style={s.visualCard}>
            <AnimatePresence mode="wait">
              {step === 'idle' && (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  style={s.idlePlaceholder}
                >
                  <p style={s.idleIcon}>🌳</p>
                  <p style={s.idleTitle}>Merkle tree will appear here</p>
                  <p style={s.idleSubtitle}>
                    Fill the form and click Issue to see the cryptographic
                    pipeline step by step.
                  </p>
                </motion.div>
              )}

              {step !== 'idle' && step !== 'complete' && step !== 'error' && (
                <motion.div key="tree" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <MerkleTreeVisual leaves={attributes} root={merkleRoot} />
                </motion.div>
              )}

              {step === 'complete' && result && (
                <motion.div
                  key="complete"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={s.resultPanel}
                >
                  {/* Success badge */}
                  <div style={s.successBadge}>
                    <span>✅</span>
                    <span>W3C Verifiable Credential Issued</span>
                  </div>

                  {/* Merkle root */}
                  <div style={s.rootRow}>
                    <span style={s.rootLabel}>Merkle Root (stored):</span>
                    <code style={s.rootValue}>{truncHash(result.merkle_root, 18)}</code>
                  </div>

                  {/* Privacy statement */}
                  <div style={s.privacyBar}>
                    <span>🛡</span>
                    <span>
                      <strong>0 bytes</strong> of raw PII stored on server.
                      Only Poseidon commitments persisted.
                    </span>
                  </div>

                  {/* QR code — compact payload, scannable by Google Lens */}
                  <p style={s.qrLabel}>
                    Scan to import into student wallet:
                  </p>
                  <div style={s.qrWrapper}>
                    <QRCodeDisplay data={JSON.stringify({
                      type:    'GovernmentID',
                      id:      result.credential_id,
                      issuer:  'did:web:gov.zk-auth.io',
                      root:    result.merkle_root.substring(0, 16),
                      fp:      result.merkle_root.substring(0, 8).toUpperCase(),
                      issued:  result.issued_at.substring(0, 10),
                      schema:  result.attribute_schema,
                      verify:  `http://localhost:3001/api/verifier/request-proof`,
                    })} />
                  </div>

                  {/* VC JSON accordion */}
                  <details style={s.vcAccordion}>
                    <summary style={s.vcSummary}>View W3C VC JSON</summary>
                    <pre style={s.vcPre}>{vcJson}</pre>
                  </details>
                </motion.div>
              )}

              {step === 'error' && (
                <motion.div
                  key="error"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  style={s.errorPanel}
                >
                  <p style={s.errorIcon}>❌</p>
                  <p style={s.errorMsg}>{error}</p>
                  <button style={s.retryBtn} onClick={() => setStep('idle')}>
                    Try Again
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>
        )} {/* end activeTab === 'issue' */}
      </main>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function truncHash(hex: string, chars = 10): string {
  if (!hex) return '—';
  const c = hex.replace(/^0x/, '');
  return `0x${c.slice(0, chars)}…`;
}

function formatAttr(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:             { minHeight: '100vh', background: '#010409', color: '#e6edf3', fontFamily: 'system-ui, -apple-system, sans-serif' },
  header:           { background: '#0d1117', borderBottom: '1px solid #21262d', padding: '0 24px' },
  headerInner:      { maxWidth: 1200, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 64 },
  logoRow:          { display: 'flex', alignItems: 'center', gap: 12 },
  logoIcon:         { fontSize: 32 },
  logoTitle:        { margin: 0, fontSize: 18, fontWeight: 700, color: '#e6edf3' },
  logoSubtitle:     { margin: 0, fontSize: 11, color: '#8b949e' },
  headerBadge:      { fontSize: 11, background: '#1f6feb22', border: '1px solid #1f6feb44', color: '#388bfd', padding: '4px 10px', borderRadius: 20 },
  main:             { maxWidth: 1200, margin: '0 auto', padding: '32px 24px' },
  grid:             { display: 'grid', gridTemplateColumns: '400px 1fr', gap: 24 },
  formCard:         { background: '#0d1117', border: '1px solid #21262d', borderRadius: 12, padding: 24 },
  visualCard:       { background: '#0d1117', border: '1px solid #21262d', borderRadius: 12, padding: 24, minHeight: 400 },
  sectionTitle:     { margin: '0 0 6px', fontSize: 18, fontWeight: 700 },
  sectionSubtitle:  { margin: '0 0 20px', fontSize: 13, color: '#8b949e', lineHeight: 1.5 },
  fieldGroup:       { marginBottom: 14 },
  label:            { display: 'block', fontSize: 12, color: '#8b949e', marginBottom: 5, fontWeight: 600 },
  input:            { width: '100%', background: '#161b22', border: '1px solid #30363d', borderRadius: 6,
                      color: '#e6edf3', padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' },
  row2:             { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  issueBtn:         { width: '100%', background: 'linear-gradient(135deg, #238636, #2ea043)', border: 'none',
                      color: '#fff', borderRadius: 8, padding: '13px', fontSize: 15, fontWeight: 700, cursor: 'pointer', marginTop: 8 },
  errorBox:         { background: '#450a0a', border: '1px solid #6e1f1f', borderRadius: 6,
                      color: '#f87171', fontSize: 13, padding: '10px 12px', marginTop: 12 },
  pipeline:         { marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 },
  pipelineStep:     { display: 'flex', alignItems: 'center', gap: 10 },
  pipelineDot:      { width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: 12, fontWeight: 700, border: '2px solid transparent',
                      flexShrink: 0, color: '#fff' },
  pipelineLabel:    { margin: 0, fontSize: 13, color: '#c9d1d9' },
  idlePlaceholder:  { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      height: 320, textAlign: 'center', color: '#484f58' },
  idleIcon:         { fontSize: 56, margin: '0 0 16px' },
  idleTitle:        { margin: '0 0 8px', fontSize: 16, fontWeight: 600, color: '#8b949e' },
  idleSubtitle:     { margin: 0, fontSize: 13, lineHeight: 1.5 },
  treeContainer:    { padding: 8 },
  treeTitle:        { margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#8b949e',
                      textTransform: 'uppercase', letterSpacing: '0.06em' },
  treeRow:          { display: 'flex', justifyContent: 'center', marginBottom: 4 },
  treeNode:         { background: '#1f6feb22', border: '2px solid #388bfd', borderRadius: 8,
                      padding: '8px 16px', textAlign: 'center', minWidth: 160 },
  treeNodeLabel:    { margin: '0 0 4px', fontSize: 10, color: '#8b949e', fontWeight: 700, letterSpacing: '0.08em' },
  treeNodeHash:     { fontSize: 11, color: '#79c0ff', fontFamily: 'monospace' },
  treeLine:         { width: 2, height: 24, background: '#21262d', margin: '0 auto' },
  leafRow:          { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 },
  leafNode:         { background: '#0d1117', border: '1px solid #21262d', borderRadius: 6, padding: 8 },
  leafLabel:        { margin: '0 0 4px', fontSize: 10, fontWeight: 700, color: '#c9d1d9', letterSpacing: '0.04em' },
  leafRaw:          { margin: '3px 0', fontSize: 10, color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4 },
  leafEncoded:      { margin: '3px 0', fontSize: 10, color: '#d2a8ff', display: 'flex', alignItems: 'center', gap: 4 },
  leafHash:         { margin: '3px 0', fontSize: 10, color: '#3fb950', display: 'flex', alignItems: 'center', gap: 4 },
  rawBadge:         { background: '#450a0a', color: '#f87171', borderRadius: 3, padding: '1px 4px', fontSize: 9, fontWeight: 700 },
  encBadge:         { background: '#2d1f6f', color: '#d2a8ff', borderRadius: 3, padding: '1px 4px', fontSize: 9, fontWeight: 700 },
  hashBadge:        { background: '#0a1d0f', color: '#4ade80', borderRadius: 3, padding: '1px 4px', fontSize: 9, fontWeight: 700 },
  hashCode:         { fontFamily: 'monospace', wordBreak: 'break-all' },
  treeProgress:     { margin: '12px 0 0', fontSize: 11, color: '#484f58', textAlign: 'center' },
  resultPanel:      { display: 'flex', flexDirection: 'column', gap: 14 },
  successBadge:     { display: 'flex', alignItems: 'center', gap: 10, background: '#0a1d0f',
                      border: '1px solid #238636', borderRadius: 8, padding: '10px 14px',
                      fontSize: 14, fontWeight: 700, color: '#4ade80' },
  rootRow:          { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                      background: '#161b22', borderRadius: 6 },
  rootLabel:        { fontSize: 11, color: '#8b949e', whiteSpace: 'nowrap' },
  rootValue:        { fontSize: 12, color: '#4ade80', fontFamily: 'monospace' },
  privacyBar:       { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                      background: '#0a1d0f', border: '1px solid #1a4028', borderRadius: 8, fontSize: 13, color: '#3fb950' },
  qrLabel:          { margin: 0, fontSize: 13, color: '#8b949e' },
  qrWrapper:        { display: 'flex', justifyContent: 'center', padding: 12,
                      background: '#fff', borderRadius: 8, width: 'fit-content' },
  qrImg:            { display: 'block', borderRadius: 4 },
  qrFallback:       { fontSize: 12, color: '#8b949e' },
  code:             { background: '#161b22', padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace' },
  vcAccordion:      { background: '#0d1117', border: '1px solid #21262d', borderRadius: 8, overflow: 'hidden' },
  vcSummary:        { padding: '10px 14px', cursor: 'pointer', fontSize: 13, color: '#8b949e', fontWeight: 600 },
  vcPre:            { margin: 0, padding: '0 14px 14px', fontSize: 11, color: '#c9d1d9',
                      overflowX: 'auto', maxHeight: 300 },
  errorPanel:       { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 32, textAlign: 'center' },
  errorIcon:        { fontSize: 48, margin: '0 0 12px' },
  errorMsg:         { color: '#f87171', margin: '0 0 16px' },
  retryBtn:         { background: '#161b22', border: '1px solid #30363d', color: '#e6edf3',
                      borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontSize: 14 },
  tabBar:           { display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid #21262d', paddingBottom: 0 },
  tabBtn:           { background: 'none', border: 'none', borderBottom: '2px solid transparent', color: '#8b949e',
                      padding: '10px 16px', fontSize: 14, cursor: 'pointer', fontWeight: 600, marginBottom: -1 },
  tabBtnActive:     { color: '#388bfd', borderBottomColor: '#388bfd' },
  behavioralPanel:  { background: '#0d1117', border: '1px solid #21262d', borderRadius: 12, padding: 24 },
};
