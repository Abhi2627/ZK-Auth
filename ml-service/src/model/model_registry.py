"""
Model Registry — stub.

Manages model versioning and hot-swap without server restart.
Phase 3 implementation.
"""
import structlog

log = structlog.get_logger(__name__)


class ModelRegistry:
    """
    Loads a model from disk and exposes it for inference.
    Supports hot-swap: load a new model version and atomically
    replace the active one without dropping in-flight requests.
    """

    def __init__(self, model_path: str, scaler_path: str, version: str) -> None:
        self._model_path = model_path
        self._scaler_path = scaler_path
        self._version = version
        self._model = None
        self._scaler = None
        log.info("model_registry.init", version=version, note="Phase 3 will load model here")

    def load(self) -> None:
        """Load model + scaler from disk. Phase 3 implementation."""
        raise NotImplementedError("ModelRegistry.load — Phase 3 target")

    def predict(self, window) -> float:
        """
        Run inference on a (window_size, n_features) array.
        Returns anomaly score ∈ [0.0, 1.0].
        Phase 3 implementation.
        """
        raise NotImplementedError("ModelRegistry.predict — Phase 3 target")

    @property
    def version(self) -> str:
        return self._version

    @property
    def is_loaded(self) -> bool:
        return self._model is not None
