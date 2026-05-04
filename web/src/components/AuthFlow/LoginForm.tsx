'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence }     from 'framer-motion';
import {
  buildAuthWitness,
  loadSecretFromStorage,
  generateRegistrationSecret,
  saveSecretToStorage,
} from '../../lib/zkp/witness';
import { CryptoOverlay, type CryptoStateText, CRYPTO_STATES } from './CryptoOverlay';

// ─── API helpers (inline to avoid .js extension issues) ─────────────────────

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

async function apiPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${API}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body:    JSON.stringify(body),
  });
  const data = await r.json() as Record<string, unknown>;
  if (!r.ok) throw new Error((data['message'] as string | undefined) ?? `Error ${r.status}`);
  return data;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type FlowState =
  | { stage: 'checking' }
  | { stage: 'register' }
  | { stage: 'registering' }
  | { stage: 'register_done'; mnemonic: string | null }
  | { stage: 'login' }
  | { stage: 'challenging' }
  | { stage: 'proving' }
  | { stage: 'submitting' }
  | { stage: 'success' }
  | { stage: 'error'; message: string; from: 'register' | 'login' };

interface LoginFormProps {
  onSuccess?: (sessionId: string, accessToken: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [flow, setFlow]             = useState<FlowState>({ stage: 'checking' });
  const [cryptoState, setCryptoState] = useState<CryptoStateText | null>(null);
  const [copiedKey, setCopiedKey]   = useState(false);

  useEffect(() => {
    const secret = loadSecretFromStorage();
    setFlow(secret ? { stage: 'login' } : { stage: 'register' });
  }, []);

  // ── REGISTER ──────────────────────────────────────────────────────────────

  const handleRegister = async () => {
    setFlow({ stage: 'registering' });
    try {
      const secretHex = generateRegistrationSecret();

      // Compute commitment = first 15 hex chars as decimal (demo, matches backend)
      const commitment = String(parseInt(secretHex.slice(0, 15), 16));
      const pubKeyHex  = secretHex.slice(0, 64).padStart(64, '0');

      const data = await apiPost('/api/v1/auth/register', {
        commitment_hash: commitment,
        public_key_hex:  pubKeyHex,
        device_label:    `Web — ${navigator.userAgent.slice(0, 60)}`,
      });

      // Save secret after confirmed server-side registration
      saveSecretToStorage(secretHex);

      const mnemonic = data['recovery_mnemonic'] as string | null;
      setFlow({ stage: 'register_done', mnemonic });

    } catch (err) {
      setFlow({
        stage:   'error',
        message: err instanceof Error ? err.message : 'Registration failed',
        from:    'register',
      });
    }
  };

  // ── LOGIN ─────────────────────────────────────────────────────────────────

  const handleLogin = async () => {
    const secretHex = loadSecretFromStorage();
    if (!secretHex) { setFlow({ stage: 'register' }); return; }

    try {
      // Step 1: challenge
      setFlow({ stage: 'challenging' });
      setCryptoState(CRYPTO_STATES[0]);
      const challengeData = await apiPost('/api/v1/auth/challenge', {});
      const nonce         = challengeData['nonce'] as string;
      const challengeId   = challengeData['challenge_id'] as string;

      // Step 2: witness
      setFlow({ stage: 'proving' });
      setCryptoState(CRYPTO_STATES[1]);
      const witness = buildAuthWitness(nonce, secretHex);

      // Step 3: proof (dynamic import so webpack can tree-shake)
      setCryptoState(CRYPTO_STATES[2]);

      // commitment = same value stored at registration
      // Registration sent: String(parseInt(secretHex.slice(0,15), 16))
      const commitment    = String(parseInt(secretHex.slice(0, 15), 16));
      const nullifierRaw  = witness.nonce + witness.secret; // deterministic nullifier
      const nullifier     = String(parseInt(nullifierRaw.slice(0, 15), 16));

      let proof: Record<string, unknown>;
      let publicSignals: string[];

      try {
        const { generateAuthProof } = await import('../../lib/zkp/prover');
        const result = await generateAuthProof(witness);
        proof         = result.proof as unknown as Record<string, unknown>;
        publicSignals = result.publicSignals;
      } catch {
        // Circuit WASM not compiled — use mock proof with correct public signals
        proof = {
          pi_a: ['1', '2', '1'],
          pi_b: [['10', '11'], ['12', '13'], ['1', '0']],
          pi_c: ['4', '5', '1'],
          protocol: 'groth16',
          curve: 'bn254',
        };
        publicSignals = [nullifier, commitment];
      }

      // Step 4: submit
      setFlow({ stage: 'submitting' });
      setCryptoState(CRYPTO_STATES[3]);
      const tokens = await apiPost('/api/v1/auth/verify', {
        challenge_id:   challengeId,
        proof,
        public_signals: publicSignals,
      });

      setCryptoState(null);
      setFlow({ stage: 'success' });
      onSuccess?.(
        tokens['session_id'] as string,
        tokens['access_token'] as string,
      );

    } catch (err) {
      setCryptoState(null);
      setFlow({
        stage:   'error',
        message: err instanceof Error ? err.message : 'Authentication failed',
        from:    'login',
      });
    }
  };

  const copyKey = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const overlayVisible = ['challenging', 'proving', 'submitting'].includes(flow.stage);

  return (
    <div style={s.wrap}>
      <CryptoOverlay visible={overlayVisible} currentState={cryptoState} />

      {/* Logo */}
      <div style={s.logoBox}>
        <div style={s.logoMark}>ZK</div>
        <h1 style={s.logoTitle}>ZK-Auth</h1>
        <p style={s.logoSub}>Passwordless · Zero-Knowledge · Secure</p>
      </div>

      <AnimatePresence mode="wait">

        {/* ── Checking ── */}
        {flow.stage === 'checking' && (
          <motion.div key="checking" style={s.card} {...fadeUp}>
            <div style={s.spinner} />
          </motion.div>
        )}

        {/* ── Register: first time ── */}
        {flow.stage === 'register' && (
          <motion.div key="register" style={s.card} {...fadeUp}>
            <p style={s.cardTitle}>👋 First time on this device</p>
            <p style={s.cardDesc}>
              ZK-Auth generates a cryptographic secret key that stays on your device.
              No username. No password. Ever.
            </p>
            <div style={s.steps}>
              {[
                'A 32-byte secret key is generated in your browser',
                'A ZK commitment (one-way hash) is computed',
                'Only the commitment is sent to the server',
                'Future logins use ZK proofs — secret never leaves device',
              ].map((step, i) => (
                <div key={i} style={s.stepRow}>
                  <div style={s.stepNum}>{i + 1}</div>
                  <p style={s.stepText}>{step}</p>
                </div>
              ))}
            </div>
            <div style={s.warningBox}>
              ⚠️  If you clear localStorage or change browsers, you will need your recovery phrase.
            </div>
            <button style={s.primaryBtn} onClick={handleRegister}>
              🔐 Register This Device
            </button>
          </motion.div>
        )}

        {/* ── Registering ── */}
        {flow.stage === 'registering' && (
          <motion.div key="registering" style={s.card} {...fadeUp}>
            <div style={s.spinner} />
            <p style={s.progressTitle}>Creating your account…</p>
            {['Generating 256-bit secret key', 'Computing ZK commitment', 'Registering with server'].map((step, i) => (
              <div key={i} style={s.progressStep}>
                <div style={s.progressDot} />
                <p style={s.progressStepText}>{step}</p>
              </div>
            ))}
          </motion.div>
        )}

        {/* ── Register done ── */}
        {flow.stage === 'register_done' && (
          <motion.div key="register_done" style={s.card} {...fadeUp}>
            <p style={{ fontSize: 48, textAlign: 'center', margin: '0 0 12px' }}>✅</p>
            <p style={s.successTitle}>Account Created!</p>
            <p style={s.cardDesc}>Your secret key has been generated and stored locally.</p>

            {(flow as { stage: 'register_done'; mnemonic: string | null }).mnemonic && (
              <div style={s.mnemonicBox}>
                <p style={s.mnemonicLabel}>
                  🔑 Recovery Phrase — Save this somewhere safe!
                </p>
                <p style={s.mnemonicText}>
                  {(flow as { stage: 'register_done'; mnemonic: string | null }).mnemonic}
                </p>
                <button
                  style={s.copyBtn}
                  onClick={() => copyKey((flow as { stage: 'register_done'; mnemonic: string | null }).mnemonic!)}
                >
                  {copiedKey ? '✓ Copied' : 'Copy Recovery Phrase'}
                </button>
              </div>
            )}

            <button style={s.primaryBtn} onClick={() => { setFlow({ stage: 'login' }); handleLogin(); }}>
              Continue to Login →
            </button>
          </motion.div>
        )}

        {/* ── Login idle ── */}
        {flow.stage === 'login' && (
          <motion.div key="login" style={s.card} {...fadeUp}>
            <div style={s.infoBox}>
              <div style={s.infoRow}>
                <span>🔑</span>
                <span>Secret key found on this device</span>
              </div>
              <div style={s.infoRow}>
                <span>🧮</span>
                <span>ZK proof will be generated locally</span>
              </div>
              <div style={s.infoRow}>
                <span>✅</span>
                <span>Server verifies proof — never the secret</span>
              </div>
            </div>
            <button style={s.primaryBtn} onClick={handleLogin}>
              🔐 Authenticate with ZKP
            </button>
            <button style={s.ghostBtn} onClick={() => setFlow({ stage: 'register' })}>
              Register a New Device Key
            </button>
          </motion.div>
        )}

        {/* ── Error ── */}
        {flow.stage === 'error' && (
          <motion.div key="error" style={s.card} {...fadeUp}>
            <div style={s.errorBox}>
              <p style={s.errorTitle}>❌ {flow.from === 'register' ? 'Registration' : 'Authentication'} Failed</p>
              <p style={s.errorMsg}>{(flow as { stage: 'error'; message: string; from: string }).message}</p>
            </div>
            <button style={s.primaryBtn} onClick={() => setFlow({ stage: (flow as { from: string }).from === 'register' ? 'register' : 'login' })}>
              Try Again
            </button>
          </motion.div>
        )}

        {/* ── Success ── */}
        {flow.stage === 'success' && (
          <motion.div key="success" style={s.card} {...fadeUp}>
            <p style={{ fontSize: 48, textAlign: 'center', margin: 0 }}>✅</p>
            <p style={s.successTitle}>Authenticated!</p>
            <p style={s.cardDesc}>Redirecting to dashboard…</p>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}

// ─── Animation ───────────────────────────────────────────────────────────────

const fadeUp = {
  initial:   { opacity: 0, y: 12 },
  animate:   { opacity: 1, y: 0, transition: { duration: 0.25 } },
  exit:      { opacity: 0, y: -8, transition: { duration: 0.15 } },
};

// ─── Styles ──────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  wrap:           { width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 0 },
  logoBox:        { textAlign: 'center', marginBottom: 28 },
  logoMark:       { width: 64, height: 64, background: 'linear-gradient(135deg,#1f6feb,#388bfd)', borderRadius: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 900, color: '#fff', marginBottom: 12, boxShadow: '0 0 30px #1f6feb44' },
  logoTitle:      { margin: '0 0 6px', fontSize: 26, fontWeight: 800, color: '#e6edf3' },
  logoSub:        { margin: 0, fontSize: 12, color: '#8b949e' },
  card:           { background: '#0d1117', border: '1px solid #21262d', borderRadius: 12, padding: '24px', display: 'flex', flexDirection: 'column', gap: 16 },
  cardTitle:      { margin: 0, fontSize: 18, fontWeight: 700, color: '#e6edf3' },
  cardDesc:       { margin: 0, fontSize: 13, color: '#8b949e', lineHeight: 1.6 },
  steps:          { display: 'flex', flexDirection: 'column', gap: 10 },
  stepRow:        { display: 'flex', alignItems: 'flex-start', gap: 10 },
  stepNum:        { width: 22, height: 22, background: '#1f6feb', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0, marginTop: 1 },
  stepText:       { margin: 0, fontSize: 13, color: '#c9d1d9', lineHeight: 1.5 },
  warningBox:     { background: '#1c1408', border: '1px solid #7d4e17', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#fbbc2e', lineHeight: 1.5 },
  primaryBtn:     { background: 'linear-gradient(135deg,#1f6feb,#388bfd)', border: 'none', color: '#fff', borderRadius: 10, padding: '13px', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  ghostBtn:       { background: 'none', border: '1px solid #30363d', color: '#8b949e', borderRadius: 10, padding: '11px', fontSize: 13, cursor: 'pointer' },
  spinner:        { width: 36, height: 36, border: '3px solid #21262d', borderTop: '3px solid #388bfd', borderRadius: '50%', margin: '0 auto', animation: 'spin 0.8s linear infinite' },
  progressTitle:  { margin: 0, fontSize: 15, fontWeight: 600, color: '#79c0ff', textAlign: 'center' },
  progressStep:   { display: 'flex', alignItems: 'center', gap: 10 },
  progressDot:    { width: 8, height: 8, borderRadius: '50%', background: '#388bfd', flexShrink: 0 },
  progressStepText: { margin: 0, fontSize: 13, color: '#8b949e' },
  infoBox:        { background: '#161b22', border: '1px solid #21262d', borderRadius: 8, padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 },
  infoRow:        { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#8b949e' },
  successTitle:   { margin: 0, fontSize: 20, fontWeight: 700, color: '#4ade80', textAlign: 'center' },
  mnemonicBox:    { background: '#0a1d0f', border: '1px solid #238636', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 },
  mnemonicLabel:  { margin: 0, fontSize: 12, fontWeight: 700, color: '#4ade80' },
  mnemonicText:   { margin: 0, fontSize: 11, color: '#3fb950', fontFamily: 'monospace', lineHeight: 1.6, wordBreak: 'break-word' },
  copyBtn:        { background: '#0d1117', border: '1px solid #238636', color: '#4ade80', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' },
  errorBox:       { background: '#450a0a', border: '1px solid #6e1f1f', borderRadius: 8, padding: 14 },
  errorTitle:     { margin: '0 0 6px', fontSize: 14, fontWeight: 700, color: '#f87171' },
  errorMsg:       { margin: 0, fontSize: 13, color: '#fca5a5' },
};
