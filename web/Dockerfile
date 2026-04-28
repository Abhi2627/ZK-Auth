# =============================================================================
# ZK-Auth Web Client — Multi-stage Dockerfile
# Stages: deps → development → builder → production
#
# Build context: ./web  (set in docker-compose.yml)
# Monorepo note: @zk-auth/types is a workspace package required at build time.
#   Because Docker build context is ./web, we copy the types package from the
#   parent via a build argument. docker-compose passes it via the context path.
#   We solve this by setting the build context to the MONOREPO ROOT and using
#   a path filter — see docker-compose.yml build.context note below.
#
#   docker-compose build.context = . (repo root)
#   dockerfile = web/Dockerfile
# =============================================================================

# ─── Base: Node 20 Alpine ─────────────────────────────────────────────────────
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ─── Dependency installation ──────────────────────────────────────────────────
FROM base AS deps

# Copy monorepo root manifest + workspace package manifests
COPY package.json package-lock.json* ./
COPY web/package.json         ./web/
COPY packages/types/package.json ./packages/types/

# Install all workspace dependencies for web + @zk-auth/types
RUN npm ci --workspace=web --workspace=@zk-auth/types --include-workspace-root

# ─── Development (hot-reload) ─────────────────────────────────────────────────
FROM deps AS development
ENV NODE_ENV=development

# Copy source files (mounted as volume in docker-compose dev, so minimal copy)
COPY web/     ./web/
COPY packages ./packages/

WORKDIR /app/web

EXPOSE 3000
# next dev listens on 0.0.0.0 so Docker port mapping works
CMD ["npx", "next", "dev", "-H", "0.0.0.0", "-p", "3000"]

# ─── Builder: production compile ──────────────────────────────────────────────
FROM deps AS builder
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY web/     ./web/
COPY packages ./packages/

WORKDIR /app/web

# next build uses NEXT_PUBLIC_* vars at build time — inject via --build-arg
ARG NEXT_PUBLIC_API_URL=http://backend:3001
ARG NEXT_PUBLIC_WS_URL=ws://backend:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}

RUN npm run build

# ─── Production: minimal standalone runtime ───────────────────────────────────
FROM base AS production
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user
RUN addgroup --system --gid 1001 nextjs && \
    adduser  --system --uid 1001 nextjs

# Copy Next.js standalone output (requires output: 'standalone' in next.config)
COPY --from=builder --chown=nextjs:nextjs /app/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/web/.next/static     ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/web/public           ./public

USER nextjs
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
