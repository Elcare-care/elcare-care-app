# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Base image digest pinning for reproducibility and security
# To pin: docker pull node:20-alpine && docker inspect node:20-alpine --format '{{index .RepoDigests 0}}'
# Update FROM line to: FROM node:20-alpine@sha256:<digest> AS builder
# Schedule: review and rotate base images at least monthly
FROM node:20-alpine AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache openssl

# Install dependencies (including devDeps for TypeScript compilation)
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma/

# Generate Prisma client for the target platform
RUN npx prisma generate

COPY src ./src/

# Copy shared config package (for cross-component validation)
COPY packages/config ./packages/config
RUN cd packages/config && npm ci --omit=dev && npm run build

# Compile TypeScript with build-time version metadata
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ARG INDEXER_VERSION=1.0.0
ARG API_VERSION=1.0.0
ARG EVENT_SCHEMA_VERSION=1
ARG DB_MIGRATION_VERSION=20260724000000
RUN BUILD_SHA="$BUILD_SHA" BUILD_TIME="$BUILD_TIME" \
    INDEXER_VERSION="$INDEXER_VERSION" API_VERSION="$API_VERSION" \
    EVENT_SCHEMA_VERSION="$EVENT_SCHEMA_VERSION" \
    DB_MIGRATION_VERSION="$DB_MIGRATION_VERSION" \
    npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
# Base image digest pinning for reproducibility and security
# To pin: docker pull node:20-alpine && docker inspect node:20-alpine --format '{{index .RepoDigests 0}}'
# Update FROM line to: FROM node:20-alpine@sha256:<digest> AS runtime
# Schedule: review and rotate base images at least monthly
FROM node:20-alpine AS runtime

WORKDIR /app

# Runtime system deps: openssl (Prisma), wget is provided by busybox (health probe)
# Minimal package set to reduce attack surface
RUN apk add --no-cache openssl nodejs npm \
 && addgroup -S appgroup \
 && adduser  -S appuser -G appgroup

# Install production-only deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output and Prisma artifacts
COPY --from=builder /build/dist               ./dist
COPY --from=builder /build/prisma             ./prisma
COPY --from=builder /build/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /build/packages/config    ./packages/config

# Copy config validation scripts
COPY scripts/validate-config.js      ./scripts/validate-config.js
COPY scripts/docker/init-config-check.sh ./scripts/docker/init-config-check.sh
RUN chmod +x ./scripts/docker/init-config-check.sh

# Transfer all /app ownership to the non-root runtime user before switching context.
# This ensures appuser can read node_modules (installed as root above) and execute
# prisma migrate deploy without a privilege escalation.
RUN chown -R appuser:appgroup /app

# OCI image labels for version tracking
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ARG INDEXER_VERSION=1.0.0
ARG API_VERSION=1.0.0
ARG EVENT_SCHEMA_VERSION=1
ARG DB_MIGRATION_VERSION=20260724000000
LABEL org.opencontainers.image.title="elcarehub-indexer"
LABEL org.opencontainers.image.version="${INDEXER_VERSION}"
LABEL org.opencontainers.image.revision="${BUILD_SHA}"
LABEL org.opencontainers.image.created="${BUILD_TIME}"
LABEL org.elcarehub.indexer.api-version="${API_VERSION}"
LABEL org.elcarehub.indexer.event-schema-version="${EVENT_SCHEMA_VERSION}"
LABEL org.elcarehub.indexer.db-migration-version="${DB_MIGRATION_VERSION}"

# Pass version metadata as runtime environment variables
ENV INDEXER_VERSION="${INDEXER_VERSION}"
ENV API_VERSION="${API_VERSION}"
ENV EVENT_SCHEMA_VERSION="${EVENT_SCHEMA_VERSION}"
ENV DB_MIGRATION_VERSION="${DB_MIGRATION_VERSION}"
ENV BUILD_SHA="${BUILD_SHA}"
ENV BUILD_TIME="${BUILD_TIME}"

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

# Send SIGTERM to allow graceful shutdown (Kubernetes rolling updates, docker stop).
STOPSIGNAL SIGTERM

USER appuser

# Run config validation then migrations then start the indexer as PID 1.
# Validation happens before migrations to catch config errors early.
CMD ["sh", "-c", "node scripts/validate-config.js && npx prisma migrate deploy && exec node dist/index.js"]
