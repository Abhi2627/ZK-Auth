/**
 * OfflineProofQR — Animated dense QR code for air-gapped verification.
 *
 * Encodes a W3C VP (Groth16 proof + public signals) as a QR code
 * that can be scanned by an offline verifier device without network access.
 *
 * Dense payload strategy:
 *   A full Groth16 proof + VP JSON is ~2KB — beyond standard QR capacity.
 *   We segment the payload into chunks of ~800 bytes each and animate
 *   between them at 1 fps. The offline verifier reconstructs the full
 *   payload by collecting all segments in sequence.
 *
 *   Segment format: JSON { idx: 0, total: 3, data: "base64url_chunk" }
 *   This is identical to the Animated QR (UR/BCUR) pattern used by
 *   hardware wallets in the Bitcoin ecosystem.
 *
 * Dependencies:
 *   qrcode — npm install qrcode @types/qrcode
 */

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { VerifiablePresentation }                       from '../../lib/types/vc.types';

interface OfflineProofQRProps {
  vp:         VerifiablePresentation | null;
  onClose?:   () => void;
}

const CHUNK_SIZE       = 700;    // bytes per QR segment (base64url chars)
const FRAME_INTERVAL   = 1_000;  // ms per frame
const QR_ERROR_CORRECT = 'M';   // Medium error correction — better density

// ─── Component ────────────────────────────────────────────────────────────────

export function OfflineProofQR({ vp, onClose }: OfflineProofQRProps) {
  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const [chunks, setChunks]     = useState<string[]>([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const [error, setError]       = useState<string | null>(null);
  const timerRef         = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Build chunks ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!vp) return;

    // Encode VP as compact JSON → base64url
    const vpJson  = JSON.stringify(vp);
    const b64     = Buffer.from(vpJson, 'utf8').toString('base64url');

    // Split into segments
    const segments: string[] = [];
    for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
      segments.push(b64.slice(i, i + CHUNK_SIZE));
    }

    const newChunks = segments.map((data, idx) =>
      JSON.stringify({ idx, total: segments.length, data }),
    );

    setChunks(newChunks);
    setFrameIdx(0);
  }, [vp]);

  // ── Animate through frames ────────────────────────────────────────────
  useEffect(() => {
    if (chunks.length === 0) return;

    timerRef.current = setInterval(() => {
      setFrameIdx((prev) => (prev + 1) % chunks.length);
    }, FRAME_INTERVAL);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [chunks]);

  // ── Render QR frame to canvas ─────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const chunk  = chunks[frameIdx];
    if (!canvas || !chunk) return;

    import('qrcode').then(({ default: QRCode }) => {
      QRCode.toCanvas(canvas, chunk, {
        errorCorrectionLevel: QR_ERROR_CORRECT,
        width:                280,
        margin:               2,
        color: {
          dark:  '#000000',
          light: '#ffffff',
        },
      }).catch((err: Error) => {
        setError(`QR render failed: ${err.message}`);
      });
    }).catch(() => {
      setError('qrcode library not installed — run: npm install qrcode @types/qrcode');
    });
  }, [chunks, frameIdx]);

  if (!vp) return null;

  return (
    <div style={s.overlay} role="dialog" aria-modal="true" aria-label="Offline proof QR code">
      <div style={s.panel}>
        <h3 style={s.title}>Offline Proof QR</h3>
        <p style={s.subtitle}>
          Show this animated QR to the verifier's offline scanner.
          <br />
          The verifier collects all frames to reconstruct the proof.
        </p>

        {error ? (
          <div style={s.error}>{error}</div>
        ) : (
          <>
            <div style={s.qrContainer}>
              <canvas ref={canvasRef} style={s.canvas} />
              {/* Animated border to indicate this is a live QR */}
              <div style={s.animBorder} aria-hidden="true" />
            </div>

            <div style={s.progress}>
              {chunks.map((_, i) => (
                <div
                  key={i}
                  style={{
                    ...s.progressDot,
                    background: i === frameIdx ? '#4ade80' : '#21262d',
                    transform:  i === frameIdx ? 'scale(1.3)' : 'scale(1)',
                  }}
                />
              ))}
            </div>

            <p style={s.frameLabel}>
              Frame {frameIdx + 1} / {chunks.length}
            </p>
          </>
        )}

        {/* Proof summary */}
        {vp.zkDisclosure && (
          <div style={s.proofSummary}>
            <p style={s.summaryRow}>
              <span style={s.summaryKey}>Predicate:</span>
              <span style={s.summaryVal}>{vp.zkDisclosure.claimedPredicate}</span>
            </p>
            <p style={s.summaryRow}>
              <span style={s.summaryKey}>Attribute:</span>
              <span style={s.summaryVal}>{vp.zkDisclosure.attributeName}</span>
            </p>
            <p style={s.summaryRow}>
              <span style={s.summaryKey}>Curve:</span>
              <span style={s.summaryVal}>{vp.zkDisclosure.groth16Proof.curve} / {vp.zkDisclosure.groth16Proof.protocol}</span>
            </p>
          </div>
        )}

        {onClose && (
          <button style={s.closeBtn} onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay:       { position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center',
                   justifyContent: 'center', background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' },
  panel:         { background: '#0d1117', border: '1px solid #30363d', borderRadius: 12,
                   padding: '24px 20px', maxWidth: 360, width: '100%', textAlign: 'center',
                   boxShadow: '0 25px 50px rgba(0,0,0,0.6)' },
  title:         { margin: '0 0 6px', fontSize: 18, fontWeight: 700, color: '#e6edf3' },
  subtitle:      { margin: '0 0 20px', fontSize: 12, color: '#8b949e', lineHeight: 1.5 },
  qrContainer:   { position: 'relative', display: 'inline-block', margin: '0 auto 12px' },
  canvas:        { display: 'block', borderRadius: 8 },
  animBorder:    { position: 'absolute', inset: -3, borderRadius: 10,
                   border: '3px solid #4ade80',
                   animation: 'pulse 1s ease-in-out infinite',
                   pointerEvents: 'none' },
  progress:      { display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 6 },
  progressDot:   { width: 8, height: 8, borderRadius: '50%', transition: 'all 0.3s ease' },
  frameLabel:    { fontSize: 11, color: '#484f58', margin: '0 0 16px' },
  error:         { padding: 12, background: '#450a0a', borderRadius: 8, color: '#f87171',
                   fontSize: 13, marginBottom: 16 },
  proofSummary:  { background: '#161b22', borderRadius: 8, padding: '10px 12px',
                   marginBottom: 16, textAlign: 'left' },
  summaryRow:    { display: 'flex', justifyContent: 'space-between', margin: '3px 0',
                   fontSize: 12 },
  summaryKey:    { color: '#8b949e' },
  summaryVal:    { color: '#c9d1d9', fontFamily: 'monospace' },
  closeBtn:      { width: '100%', background: '#161b22', border: '1px solid #30363d',
                   color: '#e6edf3', borderRadius: 8, padding: '11px', fontSize: 14,
                   cursor: 'pointer' },
};
