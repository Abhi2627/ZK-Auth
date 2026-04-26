"""
Feature Extractor — stub.

Converts raw BehaviorEvent proto messages into a fixed-dimension
numpy feature vector for LSTM input.

Feature vector (6 dims per event):
  [0] mouse_velocity      — normalised 0–1
  [1] key_dwell_ms        — normalised 0–1
  [2] scroll_delta        — normalised 0–1
  [3] touch_pressure      — 0.0–1.0 (already normalised; 0 on desktop)
  [4] event_type_encoded  — ordinal int (MOUSE=0, KEY_DOWN=1, KEY_UP=2, ...)
  [5] sequence_gap        — normalised gap from expected sequence_num

Phase 3: implement extract(event) using fitted StandardScaler.
"""

EVENT_TYPE_ENCODING = {
    "MOUSE_MOVE":   0,
    "KEY_DOWN":     1,
    "KEY_UP":       2,
    "SCROLL":       3,
    "TOUCH":        4,
    "FOCUS_LOSS":   5,
}

N_FEATURES = 6


def extract(event, scaler=None) -> list:
    """
    Extract a normalised feature vector from a BehaviorEvent.
    Phase 3 implementation.
    """
    raise NotImplementedError("Feature extraction — Phase 3 target")
