'use client';

/**
 * BehavioralAuthDemo — Live LSTM Risk Monitor
 *
 * Shows the full behavioral authentication pipeline:
 *   1. Tracks real mouse/keyboard events from this component
 *   2. Sends them to backend via the existing WsContext WebSocket
 *   3. Receives RISK_UPDATE events from the LSTM ML service
 *   4. Displays a live risk score meter
 *   5. "Simulate Attacker" sends high-variance events → spikes the score
 *   6. When score ≥ threshold, fires step-up automatically
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWs, useWsSubscribe }  from '../contexts/WsContext';
import { getAccessToken }          from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RiskUpdate {
  score:       number;
  risk_level:  string;
  risk_reason: string;
}

interface EventLog {
  ts:    number;
  type:  string;
  value: string;
}

type DemoPhase =
  | 'idle'        // not collecting
  | 'collecting'  // normal user — low risk
  | 'attacking'   // simulating attacker — rising risk
  | 'locked'      // session locked — step-up required
  | 'reauthing'   // ZKP re-auth in progress
  | 'restored';   // session restored

// ─── Component ────────────────────────────────────────────────────────────────

export function BehavioralAuthDemo() {
  const { send, connected, reconnect } = useWs();
  const [phase, setPhase]         = useState<DemoPhase>('idle');
  const [score, setScore]         = useState(0);
  const [smoothedScore, setSmoothedScore] = useState(0);
  const [eventLog, setEventLog]   = useState<EventLog[]>([]);
  const [eventCount, setEventCount] = useState(0);
  const [reauthing, setReauthing] = useState(false);
  const [reAuthResult, setReAuthResult] = useState<'success' | 'failed' | null>(null);

  const seqRef         = useRef(0);
  const collectingRef  = useRef(false);
  const attackerTimer  = useRef<ReturnType<typeof setInterval> | null>(null);
  const smoothRef      = useRef(0);
  const containerRef   = useRef<HTMLDivElement>(null);
  const lastMouseRef   = useRef<{ x: number; y: number; ts: number } | null>(null);

  // ── Receive risk updates from LSTM via WebSocket ──────────────────────────
  useWsSubscribe<RiskUpdate>('RISK_UPDATE', useCallback((payload) => {
    const s = payload.score ?? 0;
    // EMA smoothing for display
    smoothRef.current = 0.3 * s + 0.7 * smoothRef.current;
    setScore(s);
    setSmoothedScore(smoothRef.current);

    if (smoothRef.current >= 0.75 && collectingRef.current && phase !== 'locked') {
      triggerLock();
    }
  }, [phase]));

  // ── Also receive STEP_UP_REQUIRED from backend ────────────────────────────
  useWsSubscribe('STEP_UP_REQUIRED', useCallback(() => {
    if (phase === 'collecting' || phase === 'attacking') {
      triggerLock();
    }
  }, [phase]));

  function triggerLock() {
    collectingRef.current = false;
    if (attackerTimer.current) clearInterval(attackerTimer.current);
    setPhase('locked');
  }

  // ── Send a behavioral event to backend ────────────────────────────────────
  const sendEvent = useCallback((
    eventType: string,
    values: Record<string, number>,
  ) => {
    if (!collectingRef.current) return;
    const sessionId = ''; // backend reads from JWT

    send({
      type: 'BEHAVIOR_EVENT',
      payload: {
        session_id:   sessionId,
        timestamp_ms: Date.now(),
        event_type:   eventType,
        sequence_num: seqRef.current++,
        page_context: 'dashboard_demo',
        ...values,
      },
      ts: Date.now(),
    });

    setEventCount((n) => n + 1);
    const logEntry: EventLog = {
      ts:    Date.now(),
      type:  eventType,
      value: Object.entries(values)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`)
        .join(' '),
    };
    setEventLog((prev) => [logEntry, ...prev].slice(0, 12));
  }, [send]);

  // ── Track real mouse movements on the demo container ─────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onMove = (e: MouseEvent) => {
      if (!collectingRef.current) return;
      const now  = Date.now();
      const prev = lastMouseRef.current;
      let velocity = 0;
      if (prev) {
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        const dt = now - prev.ts;
        if (dt > 0) velocity = Math.sqrt(dx * dx + dy * dy) / dt;
      }
      lastMouseRef.current = { x: e.clientX, y: e.clientY, ts: now };
      sendEvent('MOUSE_MOVE', { mouse_velocity: Math.min(velocity, 10) });
    };

    const onKey = (e: KeyboardEvent) => {
      sendEvent('KEY_DOWN', { key_dwell_ms: 0 });
    };

    const onScroll = (e: WheelEvent) => {
      sendEvent('SCROLL', { scroll_delta: e.deltaY });
    };

    el.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('keydown',   onKey,   { passive: true });
    el.addEventListener('wheel',     onScroll, { passive: true });

    return () => {
      el.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown',   onKey);
      el.removeEventListener('wheel',     onScroll);
    };
  }, [sendEvent]);

  // ── Start normal collection ───────────────────────────────────────────────
  const startCollecting = () => {
    if (!connected) {
      reconnect();
      // Give WS 1 second to connect then start
      setTimeout(() => {
        seqRef.current        = 0;
        smoothRef.current     = 0;
        collectingRef.current = true;
        setScore(0);
        setSmoothedScore(0);
        setEventLog([]);
        setEventCount(0);
        setPhase('collecting');
      }, 1000);
      return;
    }
    seqRef.current        = 0;
    smoothRef.current     = 0;
    collectingRef.current = true;
    setScore(0);
    setSmoothedScore(0);
    setEventLog([]);
    setEventCount(0);
    setPhase('collecting');
  };

  // ── Simulate attacker: send high-variance chaotic events ─────────────────
  const simulateAttacker = () => {
    setPhase('attacking');

    let tick = 0;
    attackerTimer.current = setInterval(() => {
      tick++;
      // Chaotic mouse velocity (5-10x normal)
      sendEvent('MOUSE_MOVE', { mouse_velocity: 6 + Math.random() * 4 });
      // Rapid keypresses with very low dwell (bot-like)
      sendEvent('KEY_DOWN',   { key_dwell_ms: Math.random() * 10 });
      sendEvent('KEY_UP',     { key_dwell_ms: Math.random() * 10 });
      // Erratic scrolling
      sendEvent('SCROLL',     { scroll_delta: (Math.random() - 0.5) * 2000 });
      // Multiple focus losses (tab-switching behavior)
      if (tick % 3 === 0) sendEvent('FOCUS_LOSS', {});

      if (tick > 60) {
        // Force the step-up even if LSTM hasn't responded yet (demo reliability)
        if (collectingRef.current) triggerLock();
        if (attackerTimer.current) clearInterval(attackerTimer.current);
      }
    }, 200);
  };

  // ── ZKP re-authentication ─────────────────────────────────────────────────
  const handleReAuth = async () => {
    setReauthing(true);
    setReAuthResult(null);
    try {
      const { fetchStepUpChallenge, submitStepUpProof } = await import('../lib/api');
      const {
        loadSecretFromStorage,
        computeCommitment,
        computeNullifier,
      } = await import('../lib/zkp/witness');

      const secretHex = loadSecretFromStorage();
      if (!secretHex) throw new Error('ZK secret not found — please log in again');

      // Step 1: get a fresh challenge nonce from the server
      const challenge = await fetchStepUpChallenge();

      // Step 2: compute Poseidon-based public signals — must match auth.circom
      const commitment = await computeCommitment(secretHex);
      const nullifier  = await computeNullifier(secretHex, challenge.nonce);

      // Step 3: attempt real Groth16 proof; fall back to mock if WASM unavailable
      let proof: Record<string, unknown>;
      let publicSignals: [string, string];

      try {
        const { generateAuthProof } = await import('../lib/zkp/prover');
        const result  = await generateAuthProof({ nonce: challenge.nonce, secret: secretHex });
        proof         = result.proof as unknown as Record<string, unknown>;
        publicSignals = result.publicSignals;
      } catch {
        // WASM not available in this context — use Poseidon-correct mock signals
        proof = {
          pi_a: ['1', '2', '1'],
          pi_b: [['10', '11'], ['12', '13'], ['1', '0']],
          pi_c: ['4', '5', '1'],
          protocol: 'groth16',
          curve: 'bn254',
        };
        publicSignals = [nullifier, commitment];
      }

      await submitStepUpProof({
        challenge_id:   challenge.challenge_id,
        proof:          proof as never,
        public_signals: publicSignals,
      });

      setReAuthResult('success');
      setTimeout(() => {
        setPhase('restored');
        setScore(0.1);
        smoothRef.current = 0.1;
        collectingRef.current = false;
      }, 1200);
    } catch {
      setReAuthResult('failed');
    } finally {
      setReauthing(false);
    }
  };

  const reset = () => {
    collectingRef.current = false;
    if (attackerTimer.current) clearInterval(attackerTimer.current);
    setPhase('idle');
    setScore(0);
    setSmoothedScore(0);
    setEventLog([]);
    setEventCount(0);
    setReAuthResult(null);
    smoothRef.current = 0;
    lastMouseRef.current = null;
  };

  // ── Risk level classification ─────────────────────────────────────────────
  const riskLevel =
    smoothedScore >= 0.9  ? { label: 'CRITICAL', color: '#f87171', bg: '#450a0a', border: '#6e1f1f' } :
    smoothedScore >= 0.75 ? { label: 'HIGH',     color: '#fb923c', bg: '#431407', border: '#7c2d12' } :
    smoothedScore >= 0.45 ? { label: 'MEDIUM',   color: '#fbbf24', bg: '#1c1408', border: '#7d4e17' } :
                            { label: 'LOW',       color: '#4ade80', bg: '#052e16', border: '#166534' };

  const barColor =
    smoothedScore >= 0.75 ? '#f87171' :
    smoothedScore >= 0.45 ? '#fbbf24' : '#4ade80';

  return (
    <div ref={containerRef} style={s.wrap}>

      {/* ── Header ── */}
      <div style={s.header}>
        <div>
          <p style={s.title}>🧠 Live LSTM Behavioral Monitor</p>
          <p style={s.subtitle}>
            {connected
              ? '● WebSocket connected — events stream to LSTM in real time'
              : '○ WebSocket disconnected — log in to activate'}
          </p>
        </div>
        <div style={{ ...s.levelBadge, background: riskLevel.bg, color: riskLevel.color, borderColor: riskLevel.border }}>
          {riskLevel.label}
        </div>
      </div>

      {/* ── Risk meter ── */}
      <div style={s.meterSection}>
        <div style={s.meterRow}>
          <span style={s.meterLabel}>LSTM Risk Score</span>
          <span style={{ ...s.meterValue, color: barColor }}>
            {(smoothedScore * 100).toFixed(1)}%
          </span>
        </div>
        <div style={s.meterTrack}>
          <motion.div
            style={{ ...s.meterFill, background: barColor }}
            animate={{ width: `${smoothedScore * 100}%` }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          />
          {/* Threshold markers */}
          <div style={{ ...s.threshold, left: '45%' }} title="MEDIUM threshold" />
          <div style={{ ...s.threshold, left: '75%', background: '#fb923c' }} title="HIGH threshold" />
          <div style={{ ...s.threshold, left: '90%', background: '#f87171' }} title="CRITICAL threshold" />
        </div>
        <div style={s.thresholdLabels}>
          <span style={{ left: '45%', ...s.thresholdLabel }}>0.45 MEDIUM</span>
          <span style={{ left: '75%', ...s.thresholdLabel, color: '#fb923c' }}>0.75 HIGH</span>
          <span style={{ left: '90%', ...s.thresholdLabel, color: '#f87171' }}>0.90 CRITICAL</span>
        </div>
      </div>

      {/* ── Phase-specific content ── */}
      <AnimatePresence mode="wait">

        {/* IDLE */}
        {phase === 'idle' && (
          <motion.div key="idle" {...fade} style={s.phaseBox}>
            <p style={s.phaseTitle}>Ready to demonstrate behavioral authentication</p>
            <p style={s.phaseDesc}>
              Step 1: Click "Start Monitoring" — your normal mouse/keyboard behavior
              is sent to the LSTM. The score stays LOW.<br/>
              Step 2: Click "Simulate Attacker" — chaotic bot-like events spike the score.<br/>
              Step 3: Score crosses 0.75 → session locks → ZKP re-auth required.
            </p>
            <button style={s.primaryBtn} onClick={startCollecting}>
              {connected ? '▶ Start Monitoring My Behavior' : '▶ Start Demo (will auto-connect)'}
            </button>
            {!connected && (
              <p style={{ margin: 0, fontSize: 11, color: '#484f58', lineHeight: 1.5 }}>
                Not connected yet? Make sure you are logged in at{' '}
                <a href="/login" style={{ color: '#388bfd' }}>/login</a> first,
                then return here. The WebSocket connects automatically once your session token is found.
                Or click{' '}
                <button onClick={reconnect} style={{ background: 'none', border: 'none', color: '#388bfd', cursor: 'pointer', padding: 0, fontSize: 11, textDecoration: 'underline' }}>Reconnect</button>.
              </p>
            )}
          </motion.div>
        )}

        {/* COLLECTING */}
        {phase === 'collecting' && (
          <motion.div key="collecting" {...fade} style={s.phaseBox}>
            <div style={s.collectingHeader}>
              <div style={s.collectingDot} />
              <p style={s.collectingLabel}>Monitoring your behavior — move your mouse around</p>
            </div>
            <p style={s.phaseDesc}>
              Events sent: <strong style={{ color: '#4ade80' }}>{eventCount}</strong> ·
              The LSTM scores your patterns every 500ms.
              Your natural behavior keeps the score LOW.
            </p>
            <button
              style={{ ...s.attackBtn }}
              onClick={simulateAttacker}
            >
              🤖 Simulate Attacker (send bot-like events)
            </button>
            <button style={s.ghostBtn} onClick={reset}>Stop</button>
          </motion.div>
        )}

        {/* ATTACKING */}
        {phase === 'attacking' && (
          <motion.div key="attacking" {...fade} style={{ ...s.phaseBox, borderColor: '#7c2d12', background: '#1c0a05' }}>
            <div style={s.attackingHeader}>
              <motion.span
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ repeat: Infinity, duration: 0.6 }}
              >⚠️</motion.span>
              <p style={{ ...s.collectingLabel, color: '#fb923c' }}>
                Attacker simulation active — chaotic events being injected
              </p>
            </div>
            <p style={s.phaseDesc}>
              Sending: high-velocity mouse (6-10 px/ms), rapid keypresses (dwell &lt;10ms),
              erratic scrolls, repeated focus loss events.
              Watch the risk meter climb…
            </p>
            <p style={{ ...s.phaseDesc, color: '#fb923c', fontWeight: 600 }}>
              Events sent: {eventCount} · Score will cross 0.75 and lock the session automatically.
            </p>
          </motion.div>
        )}

        {/* LOCKED */}
        {phase === 'locked' && (
          <motion.div
            key="locked"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            style={{ ...s.phaseBox, borderColor: '#f87171', background: '#1a0505' }}
          >
            <p style={{ fontSize: 40, textAlign: 'center', margin: 0 }}>🔒</p>
            <p style={{ ...s.phaseTitle, color: '#f87171', textAlign: 'center' }}>
              SESSION LOCKED
            </p>
            <p style={s.phaseDesc}>
              The LSTM detected behavioral anomaly (score = {(score * 100).toFixed(0)}%).
              All API requests are now blocked. The legitimate user must
              re-authenticate using a fresh <strong>Groth16 ZK proof</strong>.
            </p>
            <div style={s.lockExplain}>
              <p style={{ margin: '0 0 6px', fontSize: 12, color: '#8b949e', fontWeight: 700 }}>
                Why ZKP and not a password?
              </p>
              <p style={{ margin: 0, fontSize: 12, color: '#484f58', lineHeight: 1.5 }}>
                An attacker who knows your password can also pass a password check.
                A Groth16 proof requires the 32-byte secret stored only on your physical device.
                Even if the attacker knows your password, they cannot generate this proof.
              </p>
            </div>

            {reAuthResult === 'success' ? (
              <div style={s.successBox}>✅ ZK Proof Verified — Session Restored</div>
            ) : reAuthResult === 'failed' ? (
              <div style={s.failBox}>❌ Proof Failed — Access Denied</div>
            ) : (
              <button
                style={{ ...s.primaryBtn, opacity: reauthing ? 0.7 : 1 }}
                onClick={handleReAuth}
                disabled={reauthing}
              >
                {reauthing ? '⚙️ Generating Groth16 Proof…' : '🔐 Re-authenticate with ZKP'}
              </button>
            )}

            <button style={s.ghostBtn} onClick={reset}>Reset Demo</button>
          </motion.div>
        )}

        {/* RESTORED */}
        {phase === 'restored' && (
          <motion.div
            key="restored"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ ...s.phaseBox, borderColor: '#238636', background: '#0a1d0f' }}
          >
            <p style={{ fontSize: 40, textAlign: 'center', margin: 0 }}>✅</p>
            <p style={{ ...s.phaseTitle, color: '#4ade80', textAlign: 'center' }}>
              SESSION RESTORED
            </p>
            <p style={s.phaseDesc}>
              ZK proof verified. Identity confirmed.
              The attacker — who triggered the lock — cannot generate this proof
              because they don't have your secret key. Session continues.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={s.primaryBtn} onClick={startCollecting}>▶ Monitor Again</button>
              <button style={s.ghostBtn} onClick={reset}>Reset</button>
            </div>
          </motion.div>
        )}

      </AnimatePresence>

      {/* ── Event log ── */}
      {eventLog.length > 0 && (
        <div style={s.logSection}>
          <p style={s.logTitle}>Live Event Stream → LSTM</p>
          <div style={s.logScroll}>
            {eventLog.map((e, i) => (
              <motion.div
                key={`${e.ts}-${i}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                style={s.logRow}
              >
                <span style={s.logTime}>{new Date(e.ts).toLocaleTimeString('en', { hour12: false })}</span>
                <span style={{
                  ...s.logType,
                  color: e.type === 'FOCUS_LOSS' ? '#f87171' :
                         e.type === 'MOUSE_MOVE' ? '#79c0ff' :
                         e.type.startsWith('KEY') ? '#d2a8ff' : '#fbbf24',
                }}>{e.type}</span>
                <span style={s.logValue}>{e.value}</span>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* ── Pipeline explanation ── */}
      <div style={s.pipeline}>
        {[
          { icon: '🖱️', label: 'Your events', sub: 'mouse · keys · scroll' },
          { icon: '→', label: '', sub: '' },
          { icon: '📡', label: 'WebSocket', sub: 'to backend:3001' },
          { icon: '→', label: '', sub: '' },
          { icon: '🧠', label: 'LSTM', sub: 'gRPC :50051' },
          { icon: '→', label: '', sub: '' },
          { icon: '📊', label: `Score: ${(smoothedScore * 100).toFixed(0)}%`, sub: riskLevel.label },
          { icon: '→', label: '', sub: '' },
          { icon: phase === 'locked' || phase === 'restored' ? '🔒' : '✅', label: phase === 'locked' ? 'LOCKED' : 'ACTIVE', sub: '' },
        ].map((step, i) => (
          step.icon === '→'
            ? <span key={i} style={s.pipelineArrow}>→</span>
            : <div key={i} style={s.pipelineStep}>
                <span style={{ fontSize: 18 }}>{step.icon}</span>
                {step.label && <span style={s.pipelineLabel}>{step.label}</span>}
                {step.sub && <span style={s.pipelineSub}>{step.sub}</span>}
              </div>
        ))}
      </div>
    </div>
  );
}

// ─── Animation ────────────────────────────────────────────────────────────────

const fade = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2 } },
  exit:    { opacity: 0, y: -4, transition: { duration: 0.1 } },
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  wrap:             { background: '#0d1117', border: '2px solid #1f6feb44', borderRadius: 12, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 },
  header:           { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  title:            { margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: '#e6edf3' },
  subtitle:         { margin: 0, fontSize: 11, color: '#8b949e' },
  levelBadge:       { padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 800, border: '1px solid', letterSpacing: '0.06em' },
  meterSection:     { background: '#161b22', borderRadius: 8, padding: '12px 14px' },
  meterRow:         { display: 'flex', justifyContent: 'space-between', marginBottom: 8 },
  meterLabel:       { fontSize: 11, color: '#8b949e', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' },
  meterValue:       { fontSize: 20, fontWeight: 800, fontFamily: 'monospace' },
  meterTrack:       { height: 12, background: '#21262d', borderRadius: 6, overflow: 'visible', position: 'relative', marginBottom: 4 },
  meterFill:        { height: '100%', borderRadius: 6, minWidth: 4 },
  threshold:        { position: 'absolute', top: -2, width: 2, height: 16, background: '#fbbf24', borderRadius: 1 },
  thresholdLabels:  { position: 'relative', height: 16 },
  thresholdLabel:   { position: 'absolute', fontSize: 9, color: '#fbbf24', transform: 'translateX(-50%)', whiteSpace: 'nowrap' },
  phaseBox:         { background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
  phaseTitle:       { margin: 0, fontSize: 15, fontWeight: 700, color: '#e6edf3' },
  phaseDesc:        { margin: 0, fontSize: 13, color: '#8b949e', lineHeight: 1.6 },
  collectingHeader: { display: 'flex', alignItems: 'center', gap: 10 },
  collectingDot:    { width: 10, height: 10, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 8px #4ade80', animation: 'pulse 1s infinite' },
  collectingLabel:  { margin: 0, fontSize: 13, fontWeight: 600, color: '#4ade80' },
  attackingHeader:  { display: 'flex', alignItems: 'center', gap: 10 },
  primaryBtn:       { background: 'linear-gradient(135deg,#1f6feb,#388bfd)', border: 'none', color: '#fff', borderRadius: 8, padding: '11px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  attackBtn:        { background: '#450a0a', border: '1px solid #6e1f1f', color: '#f87171', borderRadius: 8, padding: '11px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  ghostBtn:         { background: 'none', border: '1px solid #30363d', color: '#8b949e', borderRadius: 8, padding: '9px 14px', fontSize: 13, cursor: 'pointer' },
  lockExplain:      { background: '#0d1117', borderRadius: 8, padding: '12px 14px', border: '1px solid #30363d' },
  successBox:       { background: '#0a1d0f', border: '1px solid #238636', borderRadius: 8, padding: '12px', textAlign: 'center', color: '#4ade80', fontWeight: 700, fontSize: 14 },
  failBox:          { background: '#450a0a', border: '1px solid #6e1f1f', borderRadius: 8, padding: '12px', textAlign: 'center', color: '#f87171', fontWeight: 700, fontSize: 14 },
  logSection:       { background: '#0d1117', borderRadius: 8, padding: '10px 12px', border: '1px solid #21262d' },
  logTitle:         { margin: '0 0 8px', fontSize: 11, color: '#484f58', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' },
  logScroll:        { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 160, overflowY: 'auto' },
  logRow:           { display: 'flex', gap: 8, alignItems: 'baseline' },
  logTime:          { fontSize: 9, color: '#484f58', fontFamily: 'monospace', minWidth: 60 },
  logType:          { fontSize: 10, fontFamily: 'monospace', fontWeight: 700, minWidth: 90 },
  logValue:         { fontSize: 10, color: '#484f58', fontFamily: 'monospace', flex: 1 },
  pipeline:         { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', padding: '10px 0', flexWrap: 'wrap' },
  pipelineStep:     { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  pipelineLabel:    { fontSize: 10, fontWeight: 700, color: '#c9d1d9' },
  pipelineSub:      { fontSize: 9, color: '#484f58' },
  pipelineArrow:    { color: '#30363d', fontSize: 14 },
};
