"""
BehaviorAnalyzer gRPC Servicer — stub.

Full LSTM inference implementation: Phase 3.
This stub registers the service and returns placeholder responses
so the gateway can connect and the healthcheck passes.
"""

import time
import random
from typing import Iterator

import grpc
import structlog

log = structlog.get_logger(__name__)


class BehaviorAnalyzerServicer:
    """
    Implements the BehaviorAnalyzer gRPC service defined in behavior.proto.

    Constructor arguments mirror what server.py passes; full model loading
    is implemented in Phase 3 when src/model/ and src/inference/ are built.
    """

    def __init__(
        self,
        model_path: str,
        scaler_path: str,
        model_version: str,
        window_size: int,
        smoothing_alpha: float,
        jitter_max_ms: int,
        start_time_ms: int,
    ) -> None:
        self._model_version = model_version
        self._window_size = window_size
        self._smoothing_alpha = smoothing_alpha
        self._jitter_max_ms = jitter_max_ms
        self._start_time_ms = start_time_ms

        log.info(
            "servicer.initialized",
            model_version=model_version,
            window_size=window_size,
            note="Phase 3 will load LSTM model from disk here",
        )

    # ─── StreamEvents (bidirectional streaming) ──────────────────────────────

    def StreamEvents(
        self,
        request_iterator: Iterator,
        context: grpc.ServicerContext,
    ) -> Iterator:
        """
        Phase 3 implementation:
          1. Buffer incoming BehaviorEvents in SlidingWindow.
          2. When window is full, call predictor.predict(window).
          3. Apply EMA smoothing.
          4. Add jitter delay (anti side-channel).
          5. Yield RiskScore protobuf.
        """
        log.info("StreamEvents.stub_called", note="Phase 3 pending")
        for event in request_iterator:
            # Stub: echo back a LOW-risk score for every event received
            yield self._stub_risk_score(event.session_id)

    # ─── GetSessionRisk (unary) ──────────────────────────────────────────────

    def GetSessionRisk(self, request, context: grpc.ServicerContext):
        """Phase 3: return current smoothed risk score for session from cache."""
        log.info("GetSessionRisk.stub_called", session_id=request.session_id)
        return self._stub_risk_score(request.session_id)

    # ─── HealthCheck (unary) ─────────────────────────────────────────────────

    def HealthCheck(self, request, context: grpc.ServicerContext):
        """Server health probe — always returns OK in this stub."""
        # Import here to avoid circular at module level before proto gen
        try:
            import proto.behavior_pb2 as pb2  # type: ignore
            return pb2.HealthResponse(
                ok=True,
                model_version=self._model_version,
                uptime_ms=int(time.time() * 1000) - self._start_time_ms,
            )
        except ImportError:
            # Proto stubs not yet generated (pre-build environment)
            log.warning("HealthCheck.proto_not_generated")
            return None

    # ─── Internal helpers ────────────────────────────────────────────────────

    def _stub_risk_score(self, session_id: str):
        try:
            import proto.behavior_pb2 as pb2  # type: ignore
            return pb2.RiskScore(
                session_id=session_id,
                score=0.05,
                risk_level="LOW",
                risk_reason="NORMAL",
                evaluated_at_ms=int(time.time() * 1000),
                events_in_window=0,
                model_version=f"{self._model_version}_stub",
            )
        except ImportError:
            return None

    def _apply_jitter(self) -> None:
        """Sleep a random amount ≤ jitter_max_ms to obscure timing (anti side-channel)."""
        if self._jitter_max_ms > 0:
            jitter_s = random.uniform(0, self._jitter_max_ms / 1000)
            time.sleep(jitter_s)
