"""
Sliding Window Buffer — stub.

Maintains a fixed-size deque of BehaviorEvent feature vectors per session.
When the deque reaches window_size, yields a (window_size, n_features)
numpy array for inference.

Phase 3 implementation.
"""
from collections import deque


class SlidingWindow:
    def __init__(self, window_size: int = 50, n_features: int = 6) -> None:
        self._window_size = window_size
        self._n_features = n_features
        self._buffer: deque = deque(maxlen=window_size)

    def push(self, feature_vector: list) -> bool:
        """
        Push a feature vector. Returns True if the window is now full
        and ready for inference.
        """
        self._buffer.append(feature_vector)
        return len(self._buffer) == self._window_size

    def get_window(self):
        """
        Return the current window as a numpy array shape (window_size, n_features).
        Phase 3: import numpy and return np.array(list(self._buffer)).
        """
        raise NotImplementedError("SlidingWindow.get_window — Phase 3 target")

    def reset(self) -> None:
        self._buffer.clear()

    @property
    def size(self) -> int:
        return len(self._buffer)
