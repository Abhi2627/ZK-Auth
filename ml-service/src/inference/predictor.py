"""
Predictor — LSTM inference pipeline with EMA smoothing and jitter.

Wraps ModelRegistry to provide:
    1. Raw LSTM inference on a (WINDOW_SIZE, N_FEATURES) numpy array.
    2. EMA smoothing (T8 mitigation — adversarial evasion resistance).
    3. Uniform random jitter delay (T10 mitigation — side-channel timing defence).
    4. RiskClassification via risk_classifier.

EMA smoothing formula:
    smoothed[t] = alpha * raw[t] + (1 - alpha) * smoothed[t-1]

    alpha = 0.3 (configurable via RISK_SMOOTHING_ALPHA env var)
    Initial state: smoothed[0] = raw[0] (no prior history)

    Effect: a single anomalous window raises the score by at most alpha
    (0.3 of the spike). An adversary must sustain anomalous behaviour for
    multiple consecutive windows to push the score above the STEP_UP threshold.

    Concretely, to reach HIGH (0.75) from LOW (0.05) with alpha=0.3:
        Window 1: 0.3*1.0 + 0.7*0.05 = 0.335
        Window 2: 0.3*1.0 + 0.7*0.335 = 0.535
        Window 3: 0.3*1.0 + 0.7*0.535 = 0.674
        Window 4: 0.3*1.0 + 0.7*0.674 = 0.772 → HIGH triggered
    4 consecutive windows of full anomaly (200 events at 50-event windows).

T10 jitter:
    A uniform random sleep in [0, RESPONSE_JITTER_MAX_MS] ms is applied
    BEFORE returning each RiskScore. Combined with fixed-size proto padding
    in the servicer, this makes inference timing statistically indistinguishable
    regardless of whether the score is high or low.
"""

from __future__ import annotations

import random
import time
from typing import Optional

import numpy as np
import structlog

from src.model.model_registry import ModelRegistry
from src.inference.risk_classifier import classify, RiskClassification

log = structlog.get_logger(__name__)


class Predictor:
    """
    Per-service inference engine. One Predictor instance is shared across
    all concurrent gRPC stream handlers (model registry is thread-safe).

    EMA state is stored per-session in self._ema_state dict.
    This dict is keyed by session_id and is accessed only from the stream
    thread owning that session — no locking needed for EMA state itself.
    (If a session's stream is migrated across threads, this would need a lock.
    The current gRPC ThreadPoolExecutor model does not migrate streams.)
    """

    def __init__(
        self,
        registry: ModelRegistry,
        smoothing_alpha: float = 0.3,
        jitter_max_ms: int = 50,
        threshold_medium: float = 0.45,
        threshold_high: float = 0.75,
        threshold_critical: float = 0.90,
    ) -> None:
        self._registry          = registry
        self._alpha             = smoothing_alpha
        self._jitter_max_ms     = jitter_max_ms
        self._threshold_medium  = threshold_medium
        self._threshold_high    = threshold_high
        self._threshold_critical = threshold_critical

        # session_id → (smoothed_score, prev_smoothed_score)
        self._ema_state: dict[str, tuple[float, float | None]] = {}

    def predict(
        self,
        session_id: str,
        window_array: np.ndarray,
    ) -> tuple[float, RiskClassification]:
        """
        Run inference on a full window array, apply EMA, apply jitter,
        and return (smoothed_score, RiskClassification).

        Args:
            session_id:   Used to retrieve per-session EMA state.
            window_array: (WINDOW_SIZE, N_FEATURES) float32 numpy array.

        Returns:
            (smoothed_score ∈ [0.0, 1.0], RiskClassification)
        """
        # ── 1. Raw LSTM inference ─────────────────────────────────────────────
        raw_score = self._registry.predict(window_array)

        # ── 2. EMA smoothing (T8 mitigation) ─────────────────────────────────
        current_smoothed, prev_smoothed = self._ema_state.get(
            session_id, (raw_score, None)
        )

        if session_id in self._ema_state:
            # Update EMA: blend raw score with previous smoothed value
            new_smoothed = self._alpha * raw_score + (1.0 - self._alpha) * current_smoothed
        else:
            # First window for this session — no prior state
            new_smoothed = raw_score

        # Store updated EMA state
        self._ema_state[session_id] = (new_smoothed, current_smoothed)

        # ── 3. Classify risk ──────────────────────────────────────────────────
        classification = classify(
            score=new_smoothed,
            threshold_medium=self._threshold_medium,
            threshold_high=self._threshold_high,
            threshold_critical=self._threshold_critical,
            prev_score=current_smoothed,
        )

        log.debug(
            "predictor.scored",
            session_id=session_id,
            raw_score=round(raw_score, 4),
            smoothed_score=round(new_smoothed, 4),
            level=classification.level,
            reason=classification.reason,
        )

        # ── 4. T10 jitter (side-channel timing defence) ───────────────────────
        # Applied AFTER all computation so it does not affect the score,
        # only the response timing.
        self._apply_jitter()

        return new_smoothed, classification

    def reset_session(self, session_id: str) -> None:
        """
        Remove EMA state for a session.
        Called by the servicer when a session's gRPC stream closes.
        This is the primary EMA state cleanup path — ensures no orphaned
        session state accumulates in long-running processes.
        """
        removed = self._ema_state.pop(session_id, None)
        if removed is not None:
            log.debug("predictor.session_reset", session_id=session_id)

    @property
    def active_session_count(self) -> int:
        return len(self._ema_state)

    # ─── Private ──────────────────────────────────────────────────────────────

    def _apply_jitter(self) -> None:
        """
        Sleep a uniform random duration in [0, jitter_max_ms] milliseconds.
        Executed synchronously — this is acceptable because each gRPC stream
        handler runs in its own thread. The jitter sleeps the stream thread,
        not the gRPC server's acceptor thread.
        """
        if self._jitter_max_ms <= 0:
            return
        jitter_s = random.uniform(0.0, self._jitter_max_ms / 1_000.0)
        time.sleep(jitter_s)
