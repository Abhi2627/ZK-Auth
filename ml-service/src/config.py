"""
ML Service Configuration — pydantic-settings validated at import time.
Mirrors the Zod-validated env pattern in the Node.js backend.
"""

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # gRPC
    GRPC_PORT: int = 50051
    GRPC_MAX_WORKERS: int = 10
    GRPC_INSECURE: bool = True
    GRPC_CERT_PATH: str = "./certs/server.crt"
    GRPC_KEY_PATH: str = "./certs/server.key"
    GRPC_CA_CERT_PATH: str = "./certs/ca.crt"

    # Database
    TIMESCALE_URL: str

    # Model
    MODEL_PATH: str = "./models/lstm_v1/model.keras"
    SCALER_PATH: str = "./models/lstm_v1/scaler.pkl"
    MODEL_VERSION: str = "lstm_v1"

    # Inference
    INFERENCE_WINDOW_SIZE: int = 50
    RISK_SMOOTHING_ALPHA: float = 0.3
    RESPONSE_JITTER_MAX_MS: int = 50

    # Risk thresholds
    RISK_THRESHOLD_MEDIUM: float = 0.45
    RISK_THRESHOLD_HIGH: float = 0.75
    RISK_THRESHOLD_CRITICAL: float = 0.90

    # Logging
    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: str = "json"

    @field_validator("RISK_SMOOTHING_ALPHA")
    @classmethod
    def alpha_in_range(cls, v: float) -> float:
        if not 0 < v <= 1:
            raise ValueError("RISK_SMOOTHING_ALPHA must be in (0, 1]")
        return v

    @field_validator("RISK_THRESHOLD_MEDIUM", "RISK_THRESHOLD_HIGH", "RISK_THRESHOLD_CRITICAL")
    @classmethod
    def threshold_in_range(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("Risk thresholds must be in [0.0, 1.0]")
        return v


settings = Settings()  # type: ignore[call-arg]  # pydantic-settings reads from env
