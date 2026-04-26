# =============================================================================
# ZK-Auth API Gateway — Multi-stage Dockerfile
# Stages: base → development → builder → production
# =============================================================================

# ─── Base: common Node.js + system deps ──────────────────────────────────────
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# ─── Development: hot-reload with tsx ────────────────────────────────────────
FROM base AS development
ENV NODE_ENV=development

# Copy package manifests for layer caching
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY packages/types/package.json ./packages/types/
COPY packages/proto/package.json ./packages/proto/

RUN npm ci --workspace=backend --workspace=@zk-auth/types --include-workspace-root

# Copy source (volume-mounted in docker-compose dev)
COPY backend/ ./backend/
COPY packages/ ./packages/

WORKDIR /app/backend

# Generate Prisma client
RUN npx prisma generate

EXPOSE 3001
CMD ["npm", "run", "dev"]

# ─── Builder: compile TypeScript ─────────────────────────────────────────────
FROM base AS builder
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY packages/types/package.json ./packages/types/
COPY packages/proto/package.json ./packages/proto/

RUN npm ci --workspace=backend --workspace=@zk-auth/types --include-workspace-root

COPY backend/ ./backend/
COPY packages/ ./packages/

WORKDIR /app/backend
RUN npx prisma generate
RUN npm run build

# ─── Production: minimal runtime image ───────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodeuser && \
    adduser  --system --uid 1001 nodeuser

COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY packages/types/package.json ./packages/types/

# Install production dependencies only
RUN npm ci --workspace=backend --omit=dev --include-workspace-root && \
    npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/node_modules/.prisma ./backend/node_modules/.prisma
COPY --from=builder /app/backend/circuits ./backend/circuits

WORKDIR /app/backend
USER nodeuser

EXPOSE 3001
CMD ["node", "dist/index.js"]
