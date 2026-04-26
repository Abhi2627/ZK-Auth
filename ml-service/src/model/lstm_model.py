"""
LSTM Model Architecture — stub.

Defines the Keras LSTM model used for behavioral anomaly detection.
Full implementation: Phase 3.

Architecture (planned):
  Input  → (batch, window=50, features=6)
  LSTM(128, return_sequences=True) + Dropout(0.2)
  LSTM(64,  return_sequences=False) + Dropout(0.2)
  Dense(32, activation='relu')
  Dense(1,  activation='sigmoid')   → anomaly score ∈ [0, 1]

Feature vector (6 dims):
  [mouse_velocity, key_dwell_ms, scroll_delta, touch_pressure,
   event_type_encoded, sequence_gap]
"""


def build_lstm_model(window_size: int = 50, n_features: int = 6):
    """
    Returns a compiled Keras LSTM model.
    Phase 3 implementation.
    """
    raise NotImplementedError("LSTM model build — Phase 3 target")


def load_model(model_path: str):
    """
    Load a saved Keras model from disk.
    Phase 3 implementation.
    """
    raise NotImplementedError("Model loading — Phase 3 target")
