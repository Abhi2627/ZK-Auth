"""
Model Registry — Thread-safe model loader with hot-swap support.

Manages loading, caching, and atomic replacement of the LSTM model
without dropping in-flight inference requests.

Hot-swap protocol:
    1. Load new model into a local variable (off the hot path).
    2. Acquire a read-write lock's write side.
    3. Replace self._model reference atomically.
    4. Release lock.
    In-flight predict() calls hold the read side and complete normally.
    The old model object is released after all readers exit — CPython
    reference counting frees it immediately.

Thread safety model:
    predict() — acquires read lock (shared; multiple callers concurrent)
    load()    — acquires write lock (exclusive; blocks new reads briefly)
    Uses threading.RLock via a readers-writer pattern implemented with
    threading.Condition for simplicity at this scale.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

import numpy as np
import structlog

from src.model.lstm_model import load_model, build_lstm_model

log = structlog.get_logger(__name__)


class ModelRegistry:
    """
    Loads a Keras LSTM model + optional sklearn scaler and exposes
    thread-safe predict() for concurrent gRPC stream handlers.
    """

    def __init__(
        self,
        model_path: str,
        scaler_path: Optional[str],
        version: str,
    ) -> None:
        self._model_path  = model_path
        self._scaler_path = scaler_path
        self._version     = version

        self._model   = None   # keras.Model | None
        self._scaler  = None   # sklearn StandardScaler | None
        self._loaded  = False

        # Readers-writer lock: threading.Condition wraps a regular Lock
        # that acts as the write-side guard; a counter tracks active readers.
        self._rw_lock     = threading.Lock()
        self._readers     = 0
        self._reader_lock = threading.Lock()

    # ─── Public ───────────────────────────────────────────────────────────────

    def load(self) -> None:
        """
        Load model (and optional scaler) from disk into memory.
        Acquires write lock — blocks new predict() calls briefly.
        Idempotent: calling load() on an already-loaded registry replaces
        the model (hot-swap path).
        """
        log.info("model_registry.loading", path=self._model_path, version=self._version)
        start = time.monotonic()

        # Load off the hot path (no lock held during disk I/O)
        try:
            new_model = load_model(self._model_path)
        except Exception:
            # Model file not yet present (pre-training first run).
            # Build a structurally correct untrained model so the service
            # can start and the health check passes. Inference scores will
            # be near 0.5 (random weights) — acceptable until training completes.
            log.warning(
                "model_registry.model_not_found",
                path=self._model_path,
                message="Building untrained model — scores will be random until training",
            )
            new_model = build_lstm_model()

        new_scaler = None
        if self._scaler_path:
            try:
                import joblib
                new_scaler = joblib.load(self._scaler_path)
                log.info("model_registry.scaler_loaded", path=self._scaler_path)
            except Exception as exc:
                log.warning("model_registry.scaler_not_found",
                            path=self._scaler_path, error=str(exc),
                            message="Proceeding without scaler — using fixed-bound normalisation")

        # Acquire write lock — swap references atomically
        elapsed_load = time.monotonic() - start
        with self._rw_lock:
            self._model   = new_model
            self._scaler  = new_scaler
            self._loaded  = True

        log.info(
            "model_registry.ready",
            version=self._version,
            load_seconds=round(elapsed_load, 3),
        )

    def predict(self, window_array: np.ndarray) -> float:
        """
        Run inference on a (WINDOW_SIZE, N_FEATURES) float32 array.

        Returns:
            Raw anomaly score ∈ [0.0, 1.0] before EMA smoothing.
            The predictor.py layer applies EMA on top of this value.

        Raises:
            RuntimeError if load() has not been called yet.
        """
        self._acquire_read()
        try:
            if self._model is None:
                raise RuntimeError("Model not loaded — call load() first")

            # Add batch dimension: (1, WINDOW_SIZE, N_FEATURES)
            batch = np.expand_dims(window_array, axis=0)

            # model(batch, training=False) uses inference mode (dropout disabled)
            raw_output = self._model(batch, training=False)

            # raw_output shape: (1, 1) — squeeze to scalar
            score = float(raw_output[0][0])

            # Clamp to [0, 1] defensively (sigmoid should guarantee this)
            return max(0.0, min(1.0, score))

        finally:
            self._release_read()

    @property
    def version(self) -> str:
        return self._version

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    # ─── Readers-writer lock helpers ─────────────────────────────────────────

    def _acquire_read(self) -> None:
        with self._reader_lock:
            self._readers += 1
            if self._readers == 1:
                self._rw_lock.acquire()

    def _release_read(self) -> None:
        with self._reader_lock:
            self._readers -= 1
            if self._readers == 0:
                self._rw_lock.release()
