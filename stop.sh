#!/usr/bin/env bash
# =============================================================================
# ZK-Auth — Stop Script
# Usage: ./stop.sh           (stop services, keep DB data)
#        ./stop.sh --wipe    (stop everything + delete all DB data)
# =============================================================================

ROOT="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

info()    { echo -e "\033[0;36m[ZK-Auth]${NC} $*"; }
success() { echo -e "${GREEN}[ZK-Auth] ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}[ZK-Auth] ⚠${NC}  $*"; }

# Kill processes on our ports
info "Stopping all ZK-Auth processes…"
for port in 3000 3001 50051; do
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
    success "Stopped process on port $port"
  fi
done

# Stop Docker containers
cd "$ROOT"
if [ "${1:-}" = "--wipe" ]; then
  warn "Wiping all database data (volumes deleted)…"
  docker compose down -v 2>/dev/null || true
  success "All data wiped"
else
  docker compose down 2>/dev/null || true
  success "Docker infra stopped (data preserved)"
  info "To also delete all data run: ./stop.sh --wipe"
fi

# Clean log files
rm -rf "$ROOT/.logs"

success "ZK-Auth fully stopped"
