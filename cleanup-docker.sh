#!/usr/bin/env bash
# =============================================================================
# ZK-Auth — Docker Cleanup Script
# Removes old backend/web/ml Docker containers and images to free disk space.
# Keeps: postgres, timescaledb, redis containers + their volumes (your data)
# =============================================================================

echo "🧹 Cleaning up old ZK-Auth Docker containers and images..."

# Stop and remove old containers that we no longer run in Docker
for name in zkauth-backend zkauth-web zkauth-ml; do
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${name}$"; then
    docker stop "$name" 2>/dev/null || true
    docker rm   "$name" 2>/dev/null || true
    echo "  ✓ Removed container: $name"
  fi
done

# Remove their images to free disk space
for image in zk-auth-backend zk-auth-web zk-auth-ml-service; do
  if docker images --format '{{.Repository}}' 2>/dev/null | grep -q "$image"; then
    docker rmi "$image" 2>/dev/null || true
    echo "  ✓ Removed image: $image"
  fi
done

# Remove any dangling images (leftover build layers)
dangling=$(docker images -f "dangling=true" -q 2>/dev/null || true)
if [ -n "$dangling" ]; then
  echo "$dangling" | xargs docker rmi 2>/dev/null || true
  echo "  ✓ Removed dangling images"
fi

# Show how much space is used now
echo ""
echo "📊 Current Docker disk usage:"
docker system df 2>/dev/null || true

echo ""
echo "✅ Cleanup complete. Infra containers (postgres/timescale/redis) preserved."
echo "   Run './start.sh' to start ZK-Auth."
