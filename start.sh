#!/usr/bin/env bash
# =============================================================================
# ZK-Auth — Single-Command Startup Script
# Usage:  ./start.sh
# Stop:   ./stop.sh
#
# Starts everything in order:
#   1. Docker infra  (PostgreSQL + TimescaleDB + Redis)
#   2. Prisma migrate (auto — skipped if already current)
#   3. ML service    (Python gRPC on :50051)
#   4. Backend       (Node.js on :3001)
#   5. Web           (Next.js on :3000)
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
WEB="$ROOT/web"
ML="$ROOT/ml-service"
LOGS="$ROOT/.logs"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[ZK-Auth]${NC} $*"; }
success() { echo -e "${GREEN}[ZK-Auth] ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}[ZK-Auth] ⚠${NC}  $*"; }
error()   { echo -e "${RED}[ZK-Auth] ✗${NC} $*"; }
header()  { echo -e "\n${BOLD}${BLUE}═══ $* ═══${NC}\n"; }

mkdir -p "$LOGS"

# ── PID tracking ──────────────────────────────────────────────────────────────
ML_PID=""
BACKEND_PID=""
WEB_PID=""

cleanup() {
  echo ""
  info "Shutting down all services…"
  [ -n "$WEB_PID"     ] && kill "$WEB_PID"     2>/dev/null && info "Web stopped"
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null && info "Backend stopped"
  [ -n "$ML_PID"      ] && kill "$ML_PID"      2>/dev/null && info "ML service stopped"
  success "All services stopped. Run './stop.sh' to also stop Docker infra."
}
trap cleanup EXIT INT TERM

# ── Step 0: Kill any stale processes on our ports ─────────────────────────────
header "Clearing ports"
for port in 3000 3001 50051; do
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
    warn "Killed stale process on port $port"
  fi
done
success "Ports 3000, 3001, 50051 are free"

# ── Step 1: Docker infrastructure ─────────────────────────────────────────────
header "Starting Docker infrastructure"
cd "$ROOT"

# Stop any stale backend/web/ml Docker containers (from old config)
for name in zkauth-backend zkauth-web zkauth-ml; do
  if docker ps -a --format '{{.Names}}' | grep -q "^${name}$" 2>/dev/null; then
    docker rm -f "$name" 2>/dev/null || true
    warn "Removed old Docker container: $name"
  fi
done

docker compose up -d postgres timescaledb redis

info "Waiting for databases to be healthy…"
max_wait=60
elapsed=0
while true; do
  pg_ok=$(docker inspect zkauth-postgres  --format='{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  ts_ok=$(docker inspect zkauth-timescale --format='{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  rd_ok=$(docker inspect zkauth-redis     --format='{{.State.Health.Status}}' 2>/dev/null || echo "starting")

  if [ "$pg_ok" = "healthy" ] && [ "$ts_ok" = "healthy" ] && [ "$rd_ok" = "healthy" ]; then
    break
  fi

  elapsed=$((elapsed + 2))
  if [ $elapsed -ge $max_wait ]; then
    error "Databases did not become healthy within ${max_wait}s"
    error "Check Docker: docker compose ps"
    exit 1
  fi

  printf "\r  PostgreSQL: %-10s  TimescaleDB: %-10s  Redis: %-10s  (${elapsed}s)" \
    "$pg_ok" "$ts_ok" "$rd_ok"
  sleep 2
done
echo ""
success "All databases healthy"

# ── Step 2: Prisma migrate ─────────────────────────────────────────────────────
header "Running Prisma migrations"
cd "$BACKEND"

# Generate client (fast, always safe)
npx prisma generate --silent 2>/dev/null || npx prisma generate

# Deploy migrations (idempotent — skips already-applied migrations)
if npx prisma migrate deploy 2>&1 | tee "$LOGS/prisma.log" | grep -q "error\|Error"; then
  # If deploy fails (dev DB), try dev migrate
  warn "migrate deploy had issues, trying migrate dev…"
  npx prisma migrate dev --name "auto_$(date +%Y%m%d_%H%M%S)" --skip-seed 2>&1 | tee -a "$LOGS/prisma.log" || true
fi

success "Prisma migrations complete"

# ── Step 3: ML Service ────────────────────────────────────────────────────────
header "Starting ML Service (LSTM gRPC)"
cd "$ML"

# Create venv if it doesn't exist
if [ ! -d ".venv" ]; then
  info "Creating Python virtual environment…"
  python3 -m venv .venv
fi

source .venv/bin/activate

# Install dependencies if needed (fast if already installed)
pip install -r requirements.txt -q --disable-pip-version-check 2>/dev/null || \
  pip install -r requirements.txt -q

# Start ML service in background
python -m src.server > "$LOGS/ml.log" 2>&1 &
ML_PID=$!
info "ML service starting (PID $ML_PID)…"

# Wait for gRPC port
for i in $(seq 1 20); do
  if nc -z localhost 50051 2>/dev/null; then
    success "ML service ready on :50051"
    break
  fi
  if [ $i -eq 20 ]; then
    warn "ML service didn't start in time — behavioral auth will use circuit breaker fallback"
    warn "Check logs: tail -f $LOGS/ml.log"
  fi
  sleep 1
done

deactivate || true

# ── Step 4: Backend ───────────────────────────────────────────────────────────
header "Starting Backend (Node.js / Express)"
cd "$BACKEND"

# Make sure node_modules exist
if [ ! -d "$ROOT/node_modules" ]; then
  info "Installing npm dependencies…"
  cd "$ROOT"
  NODE_TLS_REJECT_UNAUTHORIZED=0 npm install
  cd "$BACKEND"
fi

npm run dev > "$LOGS/backend.log" 2>&1 &
BACKEND_PID=$!
info "Backend starting (PID $BACKEND_PID)…"

# Wait for backend health endpoint
for i in $(seq 1 30); do
  if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    success "Backend ready on :3001"
    break
  fi
  if [ $i -eq 30 ]; then
    error "Backend did not start in time"
    error "Check logs: tail -f $LOGS/backend.log"
    tail -20 "$LOGS/backend.log"
    exit 1
  fi
  sleep 2
done

# ── Step 5: Web ────────────────────────────────────────────────────────────────
header "Starting Web Client (Next.js)"
cd "$WEB"

npm run dev > "$LOGS/web.log" 2>&1 &
WEB_PID=$!
info "Web starting (PID $WEB_PID)…"

# Wait for Next.js ready signal
for i in $(seq 1 30); do
  if grep -q "Ready\|ready" "$LOGS/web.log" 2>/dev/null; then
    success "Web ready on :3000"
    break
  fi
  if [ $i -eq 30 ]; then
    warn "Web took longer than expected — check $LOGS/web.log"
  fi
  sleep 2
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}"
echo "╔════════════════════════════════════════════════════════╗"
echo "║          ZK-Auth is fully operational! 🚀              ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║  Web App       →  http://localhost:3000                ║"
echo "║  Login         →  http://localhost:3000/login          ║"
echo "║  Dashboard     →  http://localhost:3000/dashboard      ║"
echo "║  Issuer Portal →  http://localhost:3000/issuer         ║"
echo "║  Verifier      →  http://localhost:3000/verifier       ║"
echo "║  Backend API   →  http://localhost:3001                ║"
echo "║  ML Service    →  localhost:50051 (gRPC)               ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║  Logs: .logs/backend.log  .logs/web.log  .logs/ml.log  ║"
echo "║  Press Ctrl+C to stop all services                     ║"
echo "╚════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Keep script alive ─────────────────────────────────────────────────────────
# Stream backend logs to terminal so you can see activity
info "Streaming backend logs (Ctrl+C to stop everything):"
echo "─────────────────────────────────────────────────────────"
tail -f "$LOGS/backend.log" &
TAIL_PID=$!

# Wait for any child to exit unexpectedly
wait $BACKEND_PID || true
kill $TAIL_PID 2>/dev/null || true
error "Backend exited unexpectedly — check $LOGS/backend.log"
