# =============================================================================
# ZK-Auth ML Inference Service — Dockerfile
# Build context: . (repo root) — required because proto files live in packages/
# dockerfile: ml-service/Dockerfile
# =============================================================================

FROM python:3.11-slim AS base

# System deps: libpq for psycopg2-binary, gcc for grpcio compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq-dev \
        gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ─── Python dependencies ──────────────────────────────────────────────────────
# Copy requirements first for layer caching (only reinstall when reqs change)
COPY ml-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# ─── Proto stubs: copy from monorepo packages/ ───────────────────────────────
# Build context is repo root so this path is valid
COPY packages/proto/behavior.proto    ./proto/behavior.proto
COPY packages/proto/auth_common.proto ./proto/auth_common.proto

RUN python -m grpc_tools.protoc \
        --proto_path=./proto \
        --python_out=./proto \
        --grpc_python_out=./proto \
        ./proto/behavior.proto \
        ./proto/auth_common.proto && \
    touch ./proto/__init__.py

# ─── Application source ───────────────────────────────────────────────────────
COPY ml-service/src/     ./src/
COPY ml-service/training ./training/

# Models directory (populated at runtime via volume mount)
RUN mkdir -p ./models

# ─── Non-root user ────────────────────────────────────────────────────────────
RUN groupadd --gid 1001 mluser && \
    useradd  --uid 1001 --gid 1001 --no-create-home --shell /bin/false mluser && \
    chown -R mluser:mluser /app

USER mluser

ENV PYTHONPATH=/app

EXPOSE 50051

HEALTHCHECK --interval=15s --timeout=10s --start-period=20s --retries=5 \
    CMD python -c "\
import grpc; \
channel = grpc.insecure_channel('localhost:50051'); \
from grpc._channel import _InactiveRpcError; \
try: \
    grpc.channel_ready_future(channel).result(timeout=5); \
    exit(0) \
except: \
    exit(1)"

CMD ["python", "-m", "src.server"]
