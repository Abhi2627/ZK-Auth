/**
 * CryptoOverlay — Live ZKP proof-generation telemetry overlay
 *
 * Renders a full-viewport overlay during the authentication flow with:
 *   - A live millisecond counter (requestAnimationFrame — never setTimeout)
 *   - Sequential cryptographic state transitions with in-place
 *     fade-and-slide animation using framer-motion AnimatePresence.
 *
 * Animation contract:
 *   Each state string replaces the previous one IN THE SAME POSITION.
 *   The outgoing string slides up and fades out while the incoming string
 *   slides in from below — creating an "updating terminal" feel without
 *   layout shift. The container has a fixed height to enforce this.
 *
 * Performance:
 *   - The rAF timer loop runs only while `visible` is true.
 *   - All motion values are CSS transform + opacity — compositor-only,
 *     zero layout recalculations, never blocks the UI thread.
 *   - framer-motion uses its own animation scheduler (not React state)
 *     for the transform interpolation.
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion }             from 'framer-motion';

// ─── Telemetry states ─────────────────────────────────────────────────────────

export const CRYPTO_STATES = [
  '> Fetching Challenge Nonce...',
  '> Computing Groth16 Witness...',
  '> Generating Zero-Knowledge Proof...',
  '> Verifying Cryptographic Commitment...',
] as const;

export type CryptoStateText = (typeof CRYPTO_STATES)[number];

// ─── Props ────────────────────────────────────────────────────────────────────

interface CryptoOverlayProps {
  visible:      boolean;
  currentState: CryptoStateText | null;
  /** Optional: override elapsed ms from the parent for precise timing display. */
  elapsedMs?:   number;
}

// ─── Animation variants ───────────────────────────────────────────────────────

const textVariants = {
  initial: {
    opacity: 0,
    y: 12,
    filter: 'blur(4px)',
  },
  animate: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
  },
  exit: {
    opacity: 0,
    y: -10,
    filter: 'blur(3px)',
    transition: { duration: 0.18, ease: 'easeIn' },
  },
} as const;

const overlayVariants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit:    { opacity: 0, transition: { duration: 0.3, delay: 0.1 } },
} as const;

// ─── Component ────────────────────────────────────────────────────────────────

export function CryptoOverlay({ visible, currentState, elapsedMs }: CryptoOverlayProps) {
  // ── Internal ms counter (rAF-driven) ────────────────────────────────────
  const [internalMs, setInternalMs] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const rafRef       = useRef<number | null>(null);

  useEffect(() => {
    if (!visible) {
      setInternalMs(0);
      startTimeRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    startTimeRef.current = performance.now();

    const tick = (now: number) => {
      if (startTimeRef.current !== null) {
        setInternalMs(Math.floor(now - startTimeRef.current));
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [visible]);

  const displayMs = elapsedMs ?? internalMs;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="crypto-overlay"
          variants={overlayVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          style={styles.backdrop}
          aria-live="polite"
          aria-label="Generating zero-knowledge proof"
          role="status"
        >
          {/* Terminal window */}
          <motion.div
            style={styles.terminal}
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1,    opacity: 1, transition: { duration: 0.25, ease: 'easeOut' } }}
            exit={{    scale: 0.96, opacity: 0, transition: { duration: 0.2 } }}
          >
            {/* Terminal header bar */}
            <div style={styles.terminalHeader}>
              <div style={{ ...styles.dot, background: '#ff5f57' }} />
              <div style={{ ...styles.dot, background: '#febc2e' }} />
              <div style={{ ...styles.dot, background: '#28c840' }} />
              <span style={styles.terminalTitle}>zk-auth — proof generation</span>
            </div>

            {/* Terminal body */}
            <div style={styles.terminalBody}>
              {/* Static context lines */}
              <p style={styles.dimLine}>ZK-Auth v1.0.0 — Groth16/BN254</p>
              <p style={styles.dimLine}>Circuit: auth.circom · Curve: bn254</p>
              <div style={styles.separator} />

              {/* Animated state line — fixed height container prevents layout shift */}
              <div style={styles.stateContainer}>
                <AnimatePresence mode="wait" initial={false}>
                  {currentState && (
                    <motion.p
                      key={currentState}
                      variants={textVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      style={styles.stateLine}
                    >
                      {currentState}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>

              {/* Live millisecond counter */}
              <div style={styles.timerRow}>
                <span style={styles.timerLabel}>elapsed</span>
                <span style={styles.timerValue}>
                  {String(displayMs).padStart(6, ' ')} ms
                </span>
              </div>

              {/* Animated progress dots */}
              <div style={styles.progressRow} aria-hidden="true">
                {CRYPTO_STATES.map((s) => (
                  <motion.div
                    key={s}
                    style={{
                      ...styles.progressDot,
                      background: s === currentState
                        ? '#4ade80'
                        : CRYPTO_STATES.indexOf(s) < CRYPTO_STATES.indexOf(currentState ?? CRYPTO_STATES[0])
                          ? '#166534'
                          : '#1f2937',
                    }}
                    animate={s === currentState ? { scale: [1, 1.4, 1] } : {}}
                    transition={{ repeat: Infinity, duration: 1.2 }}
                  />
                ))}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Inline styles (no Tailwind — overlay is rendered outside normal tree) ────

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position:       'fixed',
    inset:          0,
    zIndex:         9999,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    background:     'rgba(0, 0, 0, 0.82)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
  },
  terminal: {
    background:   '#0d1117',
    border:       '1px solid #30363d',
    borderRadius: '10px',
    width:        '460px',
    maxWidth:     '92vw',
    boxShadow:    '0 25px 50px rgba(0,0,0,0.6)',
    overflow:     'hidden',
    fontFamily:   '"SF Mono", "JetBrains Mono", "Fira Code", monospace',
  },
  terminalHeader: {
    background:     '#161b22',
    borderBottom:   '1px solid #30363d',
    padding:        '10px 14px',
    display:        'flex',
    alignItems:     'center',
    gap:            '7px',
  },
  dot: {
    width:        '12px',
    height:       '12px',
    borderRadius: '50%',
  },
  terminalTitle: {
    marginLeft: '8px',
    fontSize:   '11px',
    color:      '#8b949e',
    letterSpacing: '0.02em',
  },
  terminalBody: {
    padding: '18px 20px 20px',
  },
  dimLine: {
    margin:     '0 0 4px',
    fontSize:   '12px',
    color:      '#484f58',
    lineHeight: 1.4,
  },
  separator: {
    borderTop: '1px solid #21262d',
    margin:    '12px 0',
  },
  stateContainer: {
    height:   '28px',         // fixed height — prevents layout shift on text swap
    position: 'relative',
    overflow: 'hidden',
    display:  'flex',
    alignItems: 'center',
  },
  stateLine: {
    position:      'absolute',
    margin:        0,
    fontSize:      '13px',
    fontWeight:    600,
    color:         '#4ade80',
    letterSpacing: '0.01em',
    whiteSpace:    'nowrap',
  },
  timerRow: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    marginTop:      '14px',
    padding:        '8px 10px',
    background:     '#161b22',
    borderRadius:   '4px',
    border:         '1px solid #21262d',
  },
  timerLabel: {
    fontSize: '11px',
    color:    '#484f58',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  timerValue: {
    fontSize:   '15px',
    color:      '#e6edf3',
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
  },
  progressRow: {
    display:        'flex',
    gap:            '8px',
    marginTop:      '14px',
    justifyContent: 'center',
  },
  progressDot: {
    width:        '8px',
    height:       '8px',
    borderRadius: '50%',
    transition:   'background 0.3s ease',
  },
};
