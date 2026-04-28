/**
 * gRPC Circuit Breaker — ML Service Fault Tolerance
 *
 * Implements a three-state circuit breaker wrapping the gRPC channel to
 * the Python LSTM service. Ensures a Python service outage NEVER locks
 * users out of authentication (fail-open to ZKP-only mode).
 *
 * ─── States ──────────────────────────────────────────────────────────────────
 *
 *  CLOSED (normal)
 *    All gRPC calls pass through. On failure: increment failure counter.
 *    If counter ≥ OPEN_THRESHOLD within the measurement window → OPEN.
 *
 *  OPEN (tripped)
 *    All gRPC calls are immediately rejected with CircuitOpenError.
 *    Auth pipeline catches CircuitOpenError → logs warning → continues with
 *    ZKP auth only (risk score defaults to LOW, no step-up triggering).
 *    After RESET_MS → transition to HALF_OPEN to probe service.
 *
 *  HALF_OPEN (probing)
 *    One test call is allowed through. If it succeeds → CLOSED.
 *    If it fails → back to OPEN (reset timer).
 *
 * ─── Fail-open guarantee ─────────────────────────────────────────────────────
 *    The circuit breaker is ONLY used for the risk scoring pipeline.
 *    The core ZKP proof verification path (challenge/verify/nullifier) has
 *    NO dependency on the ML service and is never affected by its outage.
 *
 * ─── Integration ─────────────────────────────────────────────────────────────
 *    import { grpcCircuitBreaker, CircuitOpenError } from './circuitBreaker.js';
 *
 *    try {
 *      const result = await grpcCircuitBreaker.call(() => grpcClient.predict(event));
 *    } catch (err) {
 *      if (err instanceof CircuitOpenError) {
 *        logger.warn('ML service unavailable — continuing with ZKP-only auth');
 *        return; // fail open
 *      }
 *      throw err;
 *    }
 */

import { env }    from '../config/env.js';
import { logger } from '../utils/logger.js';

// ─── Circuit state ────────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit breaker is OPEN — ML service is unavailable');
    this.name = 'CircuitOpenError';
  }
}

// ─── Breaker ──────────────────────────────────────────────────────────────────

export class CircuitBreaker {
  private _state:            CircuitState = 'CLOSED';
  private _failureCount:     number       = 0;
  private _lastFailureTime:  number       = 0;
  private _halfOpenProbing:  boolean      = false;

  private readonly _openThreshold: number;
  private readonly _resetMs:       number;
  private readonly _timeoutMs:     number;

  constructor(options?: {
    openThreshold?: number;
    resetMs?:       number;
    timeoutMs?:     number;
  }) {
    this._openThreshold = options?.openThreshold ?? env.GRPC_CIRCUIT_OPEN_THRESHOLD;
    this._resetMs       = options?.resetMs       ?? env.GRPC_CIRCUIT_RESET_MS;
    this._timeoutMs     = options?.timeoutMs     ?? env.GRPC_TIMEOUT_MS;
  }

  // ─── Public ───────────────────────────────────────────────────────────────

  get state(): CircuitState { return this._state; }
  get failureCount(): number { return this._failureCount; }

  /**
   * Execute a function through the circuit breaker.
   * Wraps the call with a timeout; on failure, increments the failure counter.
   *
   * @throws CircuitOpenError  — immediately if circuit is OPEN
   * @throws Error             — if the underlying call times out or throws
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    // ── Check state ───────────────────────────────────────────────────────
    if (this._state === 'OPEN') {
      const elapsed = Date.now() - this._lastFailureTime;

      if (elapsed >= this._resetMs) {
        // Transition to HALF_OPEN — allow one probe call
        this._transitionTo('HALF_OPEN');
      } else {
        throw new CircuitOpenError();
      }
    }

    if (this._state === 'HALF_OPEN') {
      if (this._halfOpenProbing) {
        // Already probing — reject this concurrent call
        throw new CircuitOpenError();
      }
      this._halfOpenProbing = true;
    }

    // ── Execute with timeout ──────────────────────────────────────────────
    try {
      const result = await this._withTimeout(fn, this._timeoutMs);
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    } finally {
      if (this._state === 'HALF_OPEN') {
        this._halfOpenProbing = false;
      }
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _onSuccess(): void {
    if (this._state !== 'CLOSED') {
      logger.info(
        { previousState: this._state },
        'Circuit breaker: ML service recovered — transitioning to CLOSED',
      );
    }
    this._failureCount = 0;
    this._transitionTo('CLOSED');
  }

  private _onFailure(err: unknown): void {
    this._failureCount++;
    this._lastFailureTime = Date.now();

    logger.warn(
      {
        state:        this._state,
        failureCount: this._failureCount,
        threshold:    this._openThreshold,
        err:          err instanceof Error ? err.message : String(err),
      },
      'Circuit breaker: ML service call failed',
    );

    if (this._state === 'HALF_OPEN') {
      // Probe failed — back to OPEN
      this._transitionTo('OPEN');
      return;
    }

    if (this._failureCount >= this._openThreshold) {
      logger.error(
        { failureCount: this._failureCount },
        'Circuit breaker TRIPPED — ML service unavailable. Falling back to ZKP-only auth.',
      );
      this._transitionTo('OPEN');
    }
  }

  private _transitionTo(state: CircuitState): void {
    const prev = this._state;
    this._state = state;
    if (prev !== state) {
      logger.info({ from: prev, to: state }, 'Circuit breaker state transition');
    }
  }

  private _withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`gRPC call timed out after ${ms}ms`));
      }, ms);

      fn().then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err)    => { clearTimeout(timer); reject(err); },
      );
    });
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
export const grpcCircuitBreaker = new CircuitBreaker();
