"""
Feature Extractor — BehaviorEvent → normalised feature vector.

Maps the 6-dimensional feature vector from a raw BehaviorEvent proto message.

Feature vector layout (index: name, normalisation):
    [0] mouse_velocity      — clip to [0, MAX_VELOCITY], then min-max scale → [0, 1]
    [1] key_dwell_ms        — clip to [0, MAX_DWELL_MS], then min-max scale → [0, 1]
    [2] scroll_delta        — clip to [-MAX_SCROLL, MAX_SCROLL], abs + scale → [0, 1]
    [3] touch_pressure      — already [0, 1]; 0.0 on desktop
    [4] event_type_encoded  — ordinal integer from EVENT_TYPE_ENCODING, scale → [0, 1]
    [5] sequence_gap        — binary flag: 0.0 = no gap, 1.0 = gap detected
                              (set by the servicer based on sequence_num delta)

Design notes:
    - Normalisation uses fixed domain bounds (not fitted StandardScaler) for the
      online inference path — we cannot update the scaler mid-stream. The scaler
      is used in the OFFLINE training path only (training/train.py).
    - The online normaliser must produce identical outputs to the training-time
      scaler for the model to generalise correctly. These bounds are documented
      and treated as hyperparameters, versioned alongside the model.
    - All values are clipped before normalisation to prevent out-of-range inputs
      from producing NaN or ±inf in the LSTM hidden state.

N_FEATURES = 6  (must match SlidingWindow.N_FEATURES and LSTM input_shape[1])
"""

from __future__ import annotations

from typing import Any

import numpy as np
import structlog

log = structlog.get_logger(__name__)

# ─── Constants ────────────────────────────────────────────────────────────────

N_FEATURES: int = 6

# Event type ordinal encoding (must be stable — never reorder)
EVENT_TYPE_ENCODING: dict[str, int] = {
    "MOUSE_MOVE":  0,
    "KEY_DOWN":    1,
    "KEY_UP":      2,
    "SCROLL":      3,
    "TOUCH":       4,
    "FOCUS_LOSS":  5,
}

N_EVENT_TYPES = len(EVENT_TYPE_ENCODING)  # 6 — used for normalisation

# Domain bounds for online normalisation (must match training-time scaler bounds)
MAX_MOUSE_VELOCITY: float = 50.0   # px/ms — p99.9 empirical upper bound
MAX_KEY_DWELL_MS:   float = 2_000.0  # 2 seconds
MAX_SCROLL_DELTA:   float = 500.0  # absolute scroll units


# ─── Extractor ────────────────────────────────────────────────────────────────

class FeatureExtractor:
    """
    Stateless feature extractor for the online inference path.

    The extract() method is called once per BehaviorEvent in the gRPC stream.
    It returns a list[float] of length N_FEATURES compatible with SlidingWindow.push().
    """

    def extract(
        self,
        event: Any,             # gRPC BehaviorEvent proto message object
        sequence_gap: bool = False,
    ) -> list[float]:
        """
        Extract and normalise features from a BehaviorEvent proto.

        Args:
            event:         BehaviorEvent proto (accessed via attribute names)
            sequence_gap:  True if sequence_num indicates a dropped-event gap

        Returns:
            list[float] of length N_FEATURES, all values in [0.0, 1.0]
        """
        # ── [0] mouse_velocity ────────────────────────────────────────────────
        raw_velocity = float(getattr(event, 'mouse_velocity', 0.0) or 0.0)
        f_velocity = np.clip(raw_velocity, 0.0, MAX_MOUSE_VELOCITY) / MAX_MOUSE_VELOCITY

        # ── [1] key_dwell_ms ─────────────────────────────────────────────────
        raw_dwell = float(getattr(event, 'key_dwell_ms', 0) or 0)
        f_dwell = np.clip(raw_dwell, 0.0, MAX_KEY_DWELL_MS) / MAX_KEY_DWELL_MS

        # ── [2] scroll_delta (absolute, normalised) ───────────────────────────
        raw_scroll = abs(float(getattr(event, 'scroll_delta', 0.0) or 0.0))
        f_scroll = np.clip(raw_scroll, 0.0, MAX_SCROLL_DELTA) / MAX_SCROLL_DELTA

        # ── [3] touch_pressure ────────────────────────────────────────────────
        raw_pressure = float(getattr(event, 'touch_pressure', 0.0) or 0.0)
        f_pressure = float(np.clip(raw_pressure, 0.0, 1.0))

        # ── [4] event_type (ordinal, normalised) ─────────────────────────────
        event_type_str = str(getattr(event, 'event_type', 'MOUSE_MOVE') or 'MOUSE_MOVE')
        ordinal = EVENT_TYPE_ENCODING.get(event_type_str, 0)
        f_event_type = ordinal / max(N_EVENT_TYPES - 1, 1)  # → [0.0, 1.0]

        # ── [5] sequence_gap (binary flag) ────────────────────────────────────
        f_gap = 1.0 if sequence_gap else 0.0

        vector = [
            float(f_velocity),
            float(f_dwell),
            float(f_scroll),
            float(f_pressure),
            float(f_event_type),
            float(f_gap),
        ]

        # Defensive NaN/inf check — should never trigger but guards the LSTM
        for i, v in enumerate(vector):
            if not np.isfinite(v):
                log.warning("feature_extractor.nan_detected", index=i, raw_value=v,
                            session_id=getattr(event, 'session_id', 'unknown'))
                vector[i] = 0.0

        return vector


# ─── Singleton ────────────────────────────────────────────────────────────────

feature_extractor = FeatureExtractor()
