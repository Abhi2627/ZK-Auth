/**
 * ZK-Auth API Client — typed fetch wrapper
 *
 * Centralises all HTTP calls to the backend API gateway.
 * Handles:
 *   - Base URL configuration
 *   - Authorization header injection from sessionStorage
 *   - Response error unwrapping into typed ApiError
 *   - Automatic token refresh on 401 (single retry)
 */

import type {
  ChallengeResponse,
  AuthTokens,
  ProofSubmission,
  ApiError,
} from '@zk-auth/types';

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

// ─── Token store ─────────────────────────────────────────────────────────────
// Access token stored in memory (not localStorage) to reduce XSS attack surface.
// Refresh token is in an HttpOnly cookie managed by the server.

let _accessToken: string | null = null;

export function setAccessToken(token: string): void {
  _accessToken = token;
}

export function clearAccessToken(): void {
  _accessToken = null;
}

export function getAccessToken(): string | null {
  return _accessToken;
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly trace: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  _retry = true,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> ?? {}),
  };

  if (_accessToken) {
    headers['Authorization'] = `Bearer ${_accessToken}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include', // include HttpOnly refresh cookie
  });

  if (res.status === 401 && _retry && _accessToken) {
    // Attempt token refresh once
    try {
      await refreshTokens();
      return apiFetch<T>(path, init, false);
    } catch {
      clearAccessToken();
      throw new ApiClientError('TOKEN_EXPIRED', 'Session expired — please log in again', '');
    }
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({
      code: 'UNKNOWN',
      message: res.statusText,
      trace: '',
    }))) as ApiError;
    throw new ApiClientError(err.code, err.message, err.trace);
  }

  return res.json() as Promise<T>;
}

// ─── Auth endpoints ───────────────────────────────────────────────────────────

export async function fetchChallenge(
  commitmentHash?: string,
): Promise<ChallengeResponse> {
  return apiFetch<ChallengeResponse>('/auth/challenge', {
    method: 'POST',
    body: JSON.stringify(commitmentHash ? { commitment_hash: commitmentHash } : {}),
  });
}

export async function submitProof(
  payload: ProofSubmission,
): Promise<AuthTokens> {
  const res = await apiFetch<AuthTokens>('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({
      challenge_id:   payload.challenge_id,
      proof:          payload.proof,
      public_signals: payload.public_signals,
    }),
  });
  // Persist access token in memory
  setAccessToken(res.access_token);
  return res;
}

export async function refreshTokens(): Promise<AuthTokens> {
  const res = await apiFetch<AuthTokens>('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  setAccessToken(res.access_token);
  return res;
}

export async function logout(allDevices = false): Promise<void> {
  await apiFetch('/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ all_devices: allDevices }),
  });
  clearAccessToken();
}

// ─── Step-up endpoints ────────────────────────────────────────────────────────

export async function fetchStepUpChallenge(): Promise<ChallengeResponse> {
  return apiFetch<ChallengeResponse>('/session/step-up/challenge', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function submitStepUpProof(
  payload: ProofSubmission,
): Promise<{ resolved: boolean }> {
  return apiFetch<{ resolved: boolean }>('/session/step-up/resolve', {
    method: 'POST',
    body: JSON.stringify({
      challenge_id:   payload.challenge_id,
      proof:          payload.proof,
      public_signals: payload.public_signals,
    }),
  });
}

export { ApiClientError };
