/**
 * LoginForm — ZKP Authentication Flow
 *
 * States:
 *   idle         → user sees the button
 *   challenging  → fetching nonce from server
 *   proving      → generating Groth16 proof (Web Worker, ~500ms)
 *   submitting   → sending proof to /auth/verify
 *   success      → redirect to dashboard
 *   error        → display error message, reset
 *
 * The component calls preloadCircuitArtifacts() on mount so the WASM/zkey
 * files are in the browser cache before the user clicks — proof generation
 * starts immediately without a network round-trip.
 */

'use client';

import React, { useEffect, useState } from 'react';
import { fetchChallenge, submitProof, ApiClientError } from '../../lib/api';
import {
  buildAuthWitness,
  loadSecretFromStorage,
  generateRegistrationSecret,
  saveSecretToStorage,
} from '../../lib/zkp/witness';
import { generateAuthProof, preloadCircuitArtifacts } from '../../lib/zkp/prover';
import { CryptoOverlay, type CryptoStateText, CRYPTO_STATES } from './CryptoOverlay';

// ─── Types ────────────────────────────────────────────────────────────────────

type LoginState =
  | { status: 'idle' }
  | { status: 'challenging' }
  | { status: 'proving' }
  | { status: 'submitting' }
  | { status: 'success'; sessionId: string }
  | { status: 'error'; message: string };

interface LoginFormProps {
  onSuccess?: (sessionId: string, accessToken: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [state, setState] = useState<LoginState>({ status: 'idle' });
  const [hasSecret, setHasSecret] = useState(false);
  const [cryptoState, setCryptoState] = useState<CryptoStateText | null>(null);

  const overlayVisible = ['challenging', 'proving', 'submitting'].includes(
    state.status,
  );

  useEffect(() => {
    // Preload circuit artifacts into browser cache
    preloadCircuitArtifacts().catch(() => {});
    // Check if user has a registered secret
    setHasSecret(loadSecretFromStorage() !== null);
  }, []);

  // ─── Registration (first-time setup) ──────────────────────────────────────

  const handleRegister = () => {
    const secret = generateRegistrationSecret();
    saveSecretToStorage(secret);
    setHasSecret(true);
    // TODO: Phase 7 — send H(secret) = commitment_hash to server to create user record
    alert(
      `Secret generated and stored locally.\n\n` +
      `IMPORTANT: Back up your secret key:\n${secret}\n\n` +
      `Losing this key means losing account access.`,
    );
  };

  // ─── ZKP Login flow ────────────────────────────────────────────────────────

  const handleLogin = async () => {
    const secretHex = loadSecretFromStorage();
    if (!secretHex) {
      setState({ status: 'error', message: 'No secret key found. Please register first.' });
      return;
    }

    try {
      // Step 1: Fetch challenge nonce
      setState({ status: 'challenging' });
      setCryptoState(CRYPTO_STATES[0]);
      const challenge = await fetchChallenge();

      // Step 2: Build witness and generate proof (Web Worker)
      setState({ status: 'proving' });
      setCryptoState(CRYPTO_STATES[1]);
      const witness = buildAuthWitness(challenge.nonce, secretHex);

      setCryptoState(CRYPTO_STATES[2]);
      const { proof, publicSignals } = await generateAuthProof(witness);

      // Step 3: Submit proof to gateway
      setState({ status: 'submitting' });
      setCryptoState(CRYPTO_STATES[3]);
      const tokens = await submitProof({
        challenge_id:   challenge.challenge_id,
        proof,
        public_signals: publicSignals,
      });

      setCryptoState(null);
      setState({ status: 'success', sessionId: tokens.session_id });
      onSuccess?.(tokens.session_id, tokens.access_token);

    } catch (err) {
      setCryptoState(null);
      const message =
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Authentication failed — please try again.';
      setState({ status: 'error', message });
    }
  };

  const reset = () => setState({ status: 'idle' });

  // ─── Render ────────────────────────────────────────────────────────────────

  const isLoading = ['challenging', 'proving', 'submitting'].includes(state.status);

  return (
    <div className="login-form">
      {/* Crypto telemetry overlay — renders above all content during proof generation */}
      <CryptoOverlay visible={overlayVisible} currentState={cryptoState} />

      <h1>ZK-Auth</h1>
      <p className="subtitle">Passwordless zero-knowledge authentication</p>

      {state.status === 'error' && (
        <div className="error-banner" role="alert">
          <span>{state.message}</span>
          <button onClick={reset} aria-label="Dismiss error">✕</button>
        </div>
      )}

      {state.status === 'success' && (
        <div className="success-banner" role="status">
          Authentication successful — redirecting…
        </div>
      )}

      {!hasSecret ? (
        <div className="register-section">
          <p>No secret key found on this device.</p>
          <button
            className="btn btn-primary"
            onClick={handleRegister}
            disabled={isLoading}
          >
            Generate Secret Key
          </button>
        </div>
      ) : (
        <button
          className="btn btn-primary"
          onClick={handleLogin}
          disabled={isLoading || state.status === 'success'}
          aria-busy={isLoading}
        >
          {isLoading ? (
            <span className="btn-loading">
              <Spinner />
              {state.status === 'challenging' && 'Fetching challenge…'}
              {state.status === 'proving'     && 'Generating proof…'}
              {state.status === 'submitting'  && 'Verifying…'}
            </span>
          ) : (
            'Authenticate'
          )}
        </button>
      )}

      {/* Progress indicator for proof generation */}
      {state.status === 'proving' && (
        <p className="proof-hint" aria-live="polite">
          Computing zero-knowledge proof — this takes a moment…
        </p>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="spinner"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="spinner-track"
        cx="12" cy="12" r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        className="spinner-arc"
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
