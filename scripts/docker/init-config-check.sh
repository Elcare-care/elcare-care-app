#!/bin/sh
# docker/init-config-check.sh — Docker init container for configuration validation
#
# Usage in Docker Compose:
#   services:
#     indexer:
#       init: true
#       command: ["sh", "-c", "sh scripts/docker/init-config-check.sh && node dist/index.js"]
#       environment:
#         - DATABASE_URL=...
#         - ...
#
# This script runs BEFORE the main process starts, ensuring configuration
# is valid before the service begins accepting traffic.

set -e

echo "[init] Running configuration validation..."

# Check if we're in a Docker container
if [ -f /etc/alpine-release ] || [ -f /etc/os-release ] || [ -d /proc ]; then
  echo "[init] Running in Docker container — performing config check"
else
  echo "[init] Not in Docker — skipping config check"
  exit 0
fi

# Run the Node.js config validation
node /scripts/validate-config.js
exit_code=$?

if [ $exit_code -ne 0 ]; then
  echo "[init] ERROR: Configuration validation failed"
  echo "[init] Service will not start until configuration is fixed"
  exit $exit_code
fi

echo "[init] Configuration validation passed — starting service..."

exit 0
