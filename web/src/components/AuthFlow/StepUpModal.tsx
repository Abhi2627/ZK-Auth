'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useWsSubscribe, useWs } from '../../contexts/WsContext';
import { fetchStepUpChallenge, submitStepUpProof, ApiClientError } from '../../lib/api';
import { buildAuthWitness, loadSecretFromStorage } from '../../lib/zkp/witness';
import { generateAuthProof } from '../../lib/zkp/prover';
import type { StepUpEvent, WsMessage } from '@zk-auth/types';

type ModalState =
  | { status: 'hidden' }
  | { status: 'visible';  level: 'SOFT' | 'HARD'; expiresAt: number; sessionId: string }
  | { status: 'proving' }
  | { status: 'submitting' }
  | { status: 'resolved' }
  | { status: 'error'; message: string; level: 'SOFT' | 'HARD'; expiresAt: number; sessionId: string }
  | { status: 'expired' };

export function StepUpModal() {
  const [modal, setModal]           = useState<ModalState>({ status: 'hidden' });
  const countdownRef                = useRef<ReturnType<typeof setInterval> | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const modalRef                    = useRef<HTMLDivElement>(null);
  const previousFocusRef            = useRef<Element | null>(null);
  const { send }                    = useWs();

  const handleStepUp = useCallback((payload: unknown) => {
    const ev = payload as StepUpEvent;
    previousFocusRef.current = document.activeElement;
    setModal({ status: 'visible', level: ev.required_level, expiresAt: ev.expires_at, sessionId: ev.session_id });
  }, []);

  useWsSubscribe<StepUpEvent>('STEP_UP_REQUIRED', handleStepUp);

  const handleResolved = useCallback(() => {
    setModal({ status: 'resolved' });
    setTimeout(() => {
      setModal({ status: 'hidden' });
      if (previousFocusRef.current instanceof HTMLElement && document.contains(previousFocusRef.current)) {
        previousFocusRef.current.focus();
      }
    }, 1_200);
  }, []);

  useWsSubscribe('SESSION_TERMINATED', () => {
    setModal({ status: 'expired' });
    setTimeout(() => { window.location.href = '/login'; }, 2_000);
  });

  useEffect(() => {
    if (modal.status !== 'visible' && modal.status !== 'error') {
      if (countdownRef.current) clearInterval(countdownRef.current);
      return;
    }
    const expiresAt = (modal as { expiresAt: number }).expiresAt;
    const update = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1_000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        setModal({ status: 'expired' });
        setTimeout(() => { window.location.href = '/login'; }, 2_000);
      }
    };
    update();
    countdownRef.current = setInterval(update, 1_000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [modal.status]);

  const isActive = !['hidden', 'resolved'].includes(modal.status);
  useEffect(() => {
    const root = document.getElementById('__next') ?? document.body;
    if (isActive) {
      root.setAttribute('aria-hidden', 'true');
      root.style.pointerEvents = 'none';
      setTimeout(() => {
        const first = modalRef.current?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        first?.focus();
      }, 50);
    } else {
      root.removeAttribute('aria-hidden');
      root.style.pointerEvents = '';
    }
  }, [isActive]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') e.preventDefault();
    if (e.key !== 'Tab' || !modalRef.current) return;
    const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last  = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, []);

  const handleReAuth = async () => {
    const secretHex = loadSecretFromStorage();
    if (!secretHex) { alert('Secret key not found on this device.'); return; }
    const currentModal = modal as Extract<ModalState, { status: 'visible' | 'error' }>;
    try {
      setModal({ status: 'proving' });
      const challenge = await fetchStepUpChallenge();
      const witness   = buildAuthWitness(challenge.nonce, secretHex);
      const { proof, publicSignals } = await generateAuthProof(witness);
      setModal({ status: 'submitting' });
      await submitStepUpProof({ challenge_id: challenge.challenge_id, proof, public_signals: publicSignals });
      handleResolved();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Re-authentication failed — please try again.';
      setModal({ status: 'error', message, level: currentModal.level, expiresAt: currentModal.expiresAt, sessionId: currentModal.sessionId });
    }
  };

  if (modal.status === 'hidden') return null;

  const isWorking = modal.status === 'proving' || modal.status === 'submitting';
  const level = 'level' in modal ? modal.level : 'SOFT';

  return (
    <div className="step-up-overlay" role="dialog" aria-modal="true"
         aria-labelledby="step-up-title" aria-describedby="step-up-desc" onKeyDown={handleKeyDown}>
      <div className="step-up-backdrop" aria-hidden="true" />
      <div ref={modalRef} className="step-up-panel">
        {modal.status === 'resolved' ? (
          <div className="step-up-resolved" aria-live="polite">
            <span>✓</span><p>Identity verified — resuming session</p>
          </div>
        ) : modal.status === 'expired' ? (
          <div className="step-up-expired" aria-live="assertive">
            <p>Session expired — redirecting to login…</p>
          </div>
        ) : (
          <>
            <div aria-hidden="true">🔐</div>
            <h2 id="step-up-title">{level === 'HARD' ? 'Re-authentication Required' : 'Verify Your Identity'}</h2>
            <p id="step-up-desc">
              {level === 'HARD'
                ? 'Unusual activity detected. Please complete a full zero-knowledge proof to continue.'
                : 'Elevated risk detected. Please confirm your identity to continue.'}
            </p>
            {modal.status === 'error' && <div role="alert">{modal.message}</div>}
            <div aria-live="polite">
              Time remaining: <strong>
                {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:{String(secondsLeft % 60).padStart(2, '0')}
              </strong>
            </div>
            <button onClick={handleReAuth} disabled={isWorking} aria-busy={isWorking}>
              {isWorking
                ? modal.status === 'proving' ? 'Generating proof…' : 'Verifying…'
                : 'Authenticate with ZKP'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
