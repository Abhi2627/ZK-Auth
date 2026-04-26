"""
Predictor — stub.

Wraps ModelRegistry with EMA smoothing and jitter delay.
Phase 3 implementation.
"""


class Predictor:
    """
    Applies EMA smoothing to raw LSTM output scores and enforces
    the anti-side-channel jitter delay before returning.
    """

    def __init__(self, registry, smoothing_alpha: float = 0.3, jitter_max_ms: int = 50) -> None:
        self._registry = registry
        self._alpha = smoothing_alpha
        self._jitter_max_ms = jitter_max_ms
        self._ema_state: dict[str, float] = {}   # session_id → last EMA score

    def predict(self, session_id: str, window) -> float:
        """
        Run inference, apply EMA, add jitter, return smoothed score.
        Phase 3 implementation.
        """
        raise NotImplementedError("Predictor.predict — Phase 3 target")

    def reset_session(self, session_id: str) -> None:
        self._ema_state.pop(session_id, None)
