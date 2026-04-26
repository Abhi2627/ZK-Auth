# =============================================================================
# ZK-Auth ML Inference Service — Dockerfile
# =============================================================================

FROM python:3.11-slim AS base

# System deps: libpq for psycopg2, build tools for grpcio compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ─── Dependencies ─────────────────────────────────────────────────────────────
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# ─── Proto codegen ────────────────────────────────────────────────────────────
COPY ../packages/proto/behavior.proto     ./proto/behavior.proto
COPY ../packages/proto/auth_common.proto  ./proto/auth_common.proto

RUN python -m grpc_tools.protoc \
    --proto_path=./proto \
    --python_out=./proto \
    --grpc_python_out=./proto \
    ./proto/behavior.proto \
    ./proto/auth_common.proto

# ─── Application source ───────────────────────────────────────────────────────
COPY src/ ./src/
COPY models/ ./models/

# Non-root user
RUN addgroup --gid 1001 mluser && \
    adduser  --uid 1001 --gid 1001 --no-create-home mluser
USER mluser

EXPOSE 50051

# Healthcheck via grpc_health_probe (installed separately in prod K8s)
HEALTHCHECK --interval=15s --timeout=10s --retries=5 \
    CMD python -c "\
import grpc; \
channel = grpc.insecure_channel('localhost:50051'); \
from grpc_health.v1 import health_pb2, health_pb2_grpc; \
stub = health_pb2_grpc.HealthStub(channel); \
resp = stub.Check(health_pb2.HealthCheckRequest(), timeout=5); \
exit(0 if resp.status == health_pb2.HealthCheckResponse.SERVING else 1)"

CMD ["python", "-m", "src.server"]
