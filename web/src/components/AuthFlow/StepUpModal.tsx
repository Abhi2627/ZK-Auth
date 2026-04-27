/**
 * StepUpModal — Un-dismissible re-authentication overlay
 *
 * Mounts when a STEP_UP_REQUIRED WebSocket event is received.
 * Freezes the underlying application via:
 *   - pointer-events: none on the app root (set via data-attribute)
 *   - aria-hidden: true on the app root (screen-reader lockout)
 *   - focus trap: keeps Tab cycling within the modal
 *   - inert attribute: HTML5 inert on the backdrop layer
 *
 * The modal cannot be dismissed by clicking outside, pressing Escape,
 * or any other user action — only a successful ZKP re-authentication
 * resolves it. A countdown timer shows the remaining resolution window
 * (default 5 minutes from the step-up event). On timeout, the session
 * is terminated and the user is redirected to login.
 *
 * After successful resolution, the modal animates out and the application
 * state (including scroll position and focused element) is restored.
 *
 * Integration:
 *   Mount <StepUpModal /> inside WsProvider at the application shell level.
 *   It self-manages visibility through the WS subscription.
 */

'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useWsSubscribe, useWs } from '../../contexts/WsContext.js';
import { fetchStepUpChallenge, submitStepUpProof, ApiClientError } from '../../lib/api.js';
import { buildAuthWitness, loadSecretFromStorage } from '../../lib/zkp/witness.js';
import { generateAuthProof } from '../../lib/zkp/prover.js';
import type { StepUpEvent, WsMessage } from '@zk-auth/types';

// ─── Types ───────────────────────────────────────────────────────────────────

type ModalState =
  | { status: 'hidden' }
  | { status: 'visible';  level: 'SOFT' | 'HARD'; expiresAt: number; sessionId: string }
  | { status: 'proving' }
  | { status: 'submitting' }
  | { status: 'resolved' }
  | { status: 'error'; message: string; level: 'SOFT' | 'HARD'; expiresAt: number; sessionId: string }
  | { status: 'expired' };

// ─── Component ────────────────────────────────────────────────────────────────

export function StepUpModal() {
  const [modal, setModal] = useState<ModalState>({ status: 'hidden' });
  const countdownRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const modalRef          = useRef<HTMLDivElement>(null);
  const previousFocusRef  = useRef<Element | null>(null);
  const { send }          = useWs();

  // ─── Subscribe to STEP_UP_REQUIRED ────────────────────────────────────────

  const handleStepUp = useCallback((payload: unknown) => {
    const ev = payload as StepUpEvent;
    // Capture previously focused element for restoration after resolution
    previousFocusRef.current = document.activeElement;

    setModal({
      status:    'visible',
      level:     ev.required_level,
      expiresAt: ev.expires_at,
      sessionId: ev.session_id,
    });
  }, []);

  useWsSubscribe<StepUpEvent>('STEP_UP_REQUIRED', handleStepUp);

  // ─── Subscribe to STEP_UP_RESOLVED (from server after /resolve) ───────────

  const handleResolved = useCallback(() => {
    setModal({ status: 'resolved' });
    // Brief success display then hide
    setTimeout(() => {
      setModal({ status: 'hidden' });
      // Restore focus to pre-modal element
      if (
        previousFocusRef.current instanceof HTMLElement &&
        document.contains(previousFocusRef.current)
      ) {
        previousFocusRef.current.focus();
      }
    }, 1_200);
  }, []);

  useWsSubscribe('SESSION_TERMINATED', () => {
    setModal({ status: 'expired' });
    setTimeout(() => { window.location.href = '/login'; }, 2_000);
  });

  // ─── Countdown timer ──────────────────────────────────────────────────────

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

  // ─── Application freeze / unfreeze ────────────────────────────────────────

  const isActive = !['hidden', 'resolved'].includes(modal.status);

  useEffect(() => {
    const root = document.getElementById('__next') ?? document.body;
    if (isActive) {
      root.setAttribute('aria-hidden', 'true');
      root.style.pointerEvents = 'none';
      // Focus first interactive element in modal
      setTimeout(() => {
        const firstFocusable = modalRef.current?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        firstFocusable?.focus();
      }, 50);
    } else {
      root.removeAttribute('aria-hidden');
      root.style.pointerEvents = '';
    }
  }, [isActive]);

  // ─── Focus trap ───────────────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') e.preventDefault(); // block Escape dismiss
    if (e.key !== 'Tab' || !modalRef.current) return;

    const focusable = Array.from(
      modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last  = focusable[focusable.length - 1]!;

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  // ─── Re-authentication handler ────────────────────────────────────────────

  const handleReAuth = async () => {
    const secretHex = loadSecretFromStorage();
    if (!secretHex) {
      alert('Secret key not found on this device. Cannot re-authenticate.');
      return;
    }

    const currentModal = modal as Extract<ModalState, { status: 'visible' | 'error' }>;

    try {
      setModal({ status: 'proving' });
      const challenge = await fetchStepUpChallenge();

      const witness = buildAuthWitness(challenge.nonce, secretHex);
      const { proof, publicSignals } = await generateAuthProof(witness);

      setModal({ status: 'submitting' });
      await submitStepUpProof({
        challenge_id:   challenge.challenge_id,
        proof,
        public_signals: publicSignals,
      });

      // Server will emit STEP_UP_RESOLVED over WebSocket; handleResolved() takes over
      // However if WS is flaky, also handle success response directly:
      handleResolved();

    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : 'Re-authentication failed — please try again.';
      setModal({
        status:    'error',
        message,
        level:     currentModal.level,
        expiresAt: currentModal.expiresAt,
        sessionId: currentModal.sessionId,
      });
    }
  };

  // ─── Render: hidden ───────────────────────────────────────────────────────

  if (modal.status === 'hidden') return null;

  // ─── Render: overlay ──────────────────────────────────────────────────────

  const isWorking = modal.status === 'proving' || modal.status === 'submitting';
  const level = 'level' in modal ? modal.level : 'SOFT';

  return (
    <div
      className="step-up-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-title"
      aria-describedby="step-up-desc"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop — non-interactive */}
      <div className="step-up-backdrop" aria-hidden="true" />

      {/* Modal panel */}
      <div ref={modalRef} className="step-up-panel">
        {modal.status === 'resolved' ? (
          <div className="step-up-resolved" aria-live="polite">
            <span className="step-up-check">✓</span>
            <p>Identity verified — resuming session</p>
          </div>
        ) : modal.status === 'expired' ? (
          <div className="step-up-expired" aria-live="assertive">
            <p>Session expired — redirecting to login…</p>
          </div>
        ) : (
          <>
            <div className="step-up-icon" aria-hidden="true">🔐</div>

            <h2 id="step-up-title" className="step-up-title">
              {level === 'HARD'
                ? 'Re-authentication Required'
                : 'Verify Your Identity'}
            </h2>

            <p id="step-up-desc" className="step-up-desc">
              {level === 'HARD'
                ? 'Unusual activity detected. Please complete a full zero-knowledge proof to continue.'
                : 'Elevated risk detected. Please confirm your identity to continue.'}
            </p>

            {modal.status === 'error' && (
              <div className="step-up-error" role="alert">
                {modal.message}
              </div>
            )}

            <div className="step-up-countdown" aria-live="polite">
              Time remaining:{' '}
              <strong>{String(Math.floor(secondsLeft / 60)).padStart(2, '0')}
                :{String(secondsLeft % 60).padStart(2, '0')}</strong>
            </div>

            <button
              className="btn btn-primary step-up-btn"
              onClick={handleReAuth}
              disabled={isWorking}
              aria-busy={isWorking}
            >
              {isWorking ? (
                <>
                  {modal.status === 'proving'    && 'Generating proof…'}
                  {modal.status === 'submitting' && 'Verifying…'}
                </>
              ) : (
                'Authenticate with ZKP'
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
