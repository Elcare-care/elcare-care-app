# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Base image digest pinning for reproducibility and security
# To pin: docker pull node:20-alpine && docker inspect node:20-alpine --format '{{index .RepoDigests 0}}'
# Update FROM line to: FROM node:20-alpine@sha256:<digest> AS builder
# Schedule: review and rotate base images at least monthly
FROM node:20-alpine AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache openssl

# Install dependencies (including devDeps for TypeScript compilation and build)
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build-time env vars are baked into the client bundle by Next.js
ARG NEXT_PUBLIC_CONTRACT_ID
ARG NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ID
ARG NEXT_PUBLIC_STELLAR_NETWORK
ARG NEXT_PUBLIC_STELLAR_RPC_URL
ARG NEXT_PUBLIC_STELLAR_HORIZON_URL
ARG NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE
ARG NEXT_PUBLIC_INDEXER_URL
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_PINATA_GATEWAY
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ARG APP_VERSION=0.1.0
ARG INDEXER_API_VERSION=1.0.0
ARG EVENT_SCHEMA_VERSION=1

ENV NEXT_PUBLIC_CONTRACT_ID=$NEXT_PUBLIC_CONTRACT_ID
ENV NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ID=$NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ID
ENV NEXT_PUBLIC_STELLAR_NETWORK=$NEXT_PUBLIC_STELLAR_NETWORK
ENV NEXT_PUBLIC_STELLAR_RPC_URL=$NEXT_PUBLIC_STELLAR_RPC_URL
ENV NEXT_PUBLIC_STELLAR_HORIZON_URL=$NEXT_PUBLIC_STELLAR_HORIZON_URL
ENV NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE=$NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE
ENV NEXT_PUBLIC_INDEXER_URL=$NEXT_PUBLIC_INDEXER_URL
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_PINATA_GATEWAY=$NEXT_PUBLIC_PINATA_GATEWAY
ENV SENTRY_ORG=$SENTRY_ORG
ENV SENTRY_PROJECT=$SENTRY_PROJECT
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_TIME=$BUILD_TIME
ENV APP_VERSION=$APP_VERSION
ENV INDEXER_API_VERSION=$INDEXER_API_VERSION
ENV EVENT_SCHEMA_VERSION=$EVENT_SCHEMA_VERSION

# Build the Next.js application
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
# Base image digest pinning for reproducibility and security
# To pin: docker pull node:20-alpine && docker inspect node:20-alpine --format '{{index .RepoDigests 0}}'
# Update FROM line to: FROM node:20-alpine@sha256:<digest> AS runtime
# Schedule: review and rotate base images at least monthly
FROM node:20-alpine AS runtime

WORKDIR /app

# Create non-root user and group
RUN addgroup -S appgroup \
 && adduser -S appuser -G appgroup

# Install runtime dependencies (minimal - only what's needed for Next.js runtime)
RUN apk add --no-cache openssl \
 && addgroup -S appgroup \
 && adduser -S appuser -G appgroup

# Copy package files and install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built application from builder
COPY --from=builder /build/.next ./.next
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/public ./public
COPY --from=builder /build/next.config.js ./next.config.js
COPY --from=builder /build/package.json ./package.json

# Transfer ownership to non-root user
RUN chown -R appuser:appgroup /app

# OCI image labels for version tracking
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ARG APP_VERSION=0.1.0
ARG INDEXER_API_VERSION=1.0.0
ARG EVENT_SCHEMA_VERSION=1
LABEL org.opencontainers.image.title="elcarehub-frontend"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.revision="${BUILD_SHA}"
LABEL org.opencontainers.image.created="${BUILD_TIME}"
LABEL org.elcarehub.frontend.indexer-api-version="${INDEXER_API_VERSION}"
LABEL org.elcarehub.frontend.event-schema-version="${EVENT_SCHEMA_VERSION}"

# Pass version metadata as runtime environment variables
ENV APP_VERSION="${APP_VERSION}"
ENV INDEXER_API_VERSION="${INDEXER_API_VERSION}"
ENV EVENT_SCHEMA_VERSION="${EVENT_SCHEMA_VERSION}"
ENV BUILD_SHA="${BUILD_SHA}"
ENV BUILD_TIME="${BUILD_TIME}"
ENV NODE_ENV=production

EXPOSE 3000

# Health check for the Next.js server
# Use the dedicated health endpoint for accurate service status
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# Send SIGTERM to allow graceful shutdown
STOPSIGNAL SIGTERM

# Switch to non-root user
USER appuser

# Start the Next.js production server
# Using exec ensures SIGTERM is delivered directly to node, not swallowed by shell
CMD ["sh", "-c", "exec node node_modules/next/dist/bin/next start"]