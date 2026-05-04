"""
ZK-Auth ML Inference Service — gRPC Server Entry Point

Responsibilities:
  1. Load and validate configuration (pydantic-settings, fail-fast).
  2. Load LSTM model + scaler from disk.
  3. Start gRPC server with BehaviorAnalyzer servicer.
  4. Register OS signal handlers for graceful shutdown.

Full inference logic is in src/servicer/ and src/inference/.
This file only wires the server together.
"""

import signal
import sys
import time
from concurrent import futures
from pathlib import Path
from typing import Optional

import grpc
import structlog

# Add proto directory to path so generated grpc files can import behavior_pb2
sys.path.insert(0, str(Path(__file__).parent.parent / "proto"))

from src.config import settings
from src.servicer.behavior_servicer import BehaviorAnalyzerServicer

# Proto-generated stubs — generated at container build time
import proto.behavior_pb2_grpc as behavior_pb2_grpc  # type: ignore

log = structlog.get_logger(__name__)

_start_time_ms = int(time.time() * 1000)


def build_server_credentials() -> Optional[grpc.ServerCredentials]:
    """Return mTLS credentials in production, None for insecure dev mode."""
    if settings.GRPC_INSECURE:
        log.warning("grpc.insecure_mode", message="gRPC running without TLS — dev only!")
        return None

    with open(settings.GRPC_CA_CERT_PATH, "rb") as f:
        root_cert = f.read()
    with open(settings.GRPC_KEY_PATH, "rb") as f:
        server_key = f.read()
    with open(settings.GRPC_CERT_PATH, "rb") as f:
        server_cert = f.read()

    return grpc.ssl_server_credentials(
        [(server_key, server_cert)],
        root_certificates=root_cert,
        require_client_auth=True,   # mTLS — require client certificate
    )


def serve() -> None:
    log.info("ml_service.starting", port=settings.GRPC_PORT, model=settings.MODEL_VERSION)

    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=settings.GRPC_MAX_WORKERS),
        options=[
            ("grpc.max_receive_message_length", 4 * 1024 * 1024),   # 4 MB
            ("grpc.max_send_message_length",    4 * 1024 * 1024),
            ("grpc.keepalive_time_ms",          30_000),
            ("grpc.keepalive_timeout_ms",       10_000),
            ("grpc.keepalive_permit_without_calls", True),
        ],
    )

    # Register servicer
    servicer = BehaviorAnalyzerServicer(
        model_path=settings.MODEL_PATH,
        scaler_path=settings.SCALER_PATH,
        model_version=settings.MODEL_VERSION,
        window_size=settings.INFERENCE_WINDOW_SIZE,
        smoothing_alpha=settings.RISK_SMOOTHING_ALPHA,
        jitter_max_ms=settings.RESPONSE_JITTER_MAX_MS,
        start_time_ms=_start_time_ms,
    )
    behavior_pb2_grpc.add_BehaviorAnalyzerServicer_to_server(servicer, server)

    # Bind port
    creds = build_server_credentials()
    bind_address = f"[::]:{settings.GRPC_PORT}"
    if creds:
        server.add_secure_port(bind_address, creds)
    else:
        server.add_insecure_port(bind_address)

    server.start()
    log.info("ml_service.ready", address=bind_address)

    # ─── Graceful Shutdown ───────────────────────────────────────────────────

    def _shutdown(signum: int, _frame: object) -> None:
        sig_name = signal.Signals(signum).name
        log.info("ml_service.shutdown_signal", signal=sig_name)
        grace_seconds = 10
        server.stop(grace=grace_seconds)
        log.info("ml_service.stopped", grace_seconds=grace_seconds)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT,  _shutdown)

    server.wait_for_termination()


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=settings.LOG_LEVEL)
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.add_log_level,
            structlog.processors.JSONRenderer(),
        ]
    )
    serve()
