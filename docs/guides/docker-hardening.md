# Docker Hardening Guide

## Overview

This guide documents the security hardening measures applied to ElcareHub Docker containers and provides deployment guidance for production environments. All containers run with minimal privileges and predictable filesystem behavior unless explicitly documented exceptions exist.

## Security Hardening Standards

### Baseline Requirements

All production containers must:
- Run as non-root users
- Use read-only filesystems where possible
- Drop all Linux capabilities
- Prevent privilege escalation
- Include health checks
- Use minimal runtime packages
- Avoid baking secrets into image layers

### Container Status

| Container | Non-Root User | Read-Only FS | Capabilities Dropped | Health Check | Secrets in Layers |
|-----------|---------------|--------------|---------------------|--------------|-------------------|
| Indexer | ✅ `appuser` | ✅ (prod) | ✅ ALL | ✅ `/health` | ❌ None |
| Frontend | ✅ `appuser` | ✅ (prod) | ✅ ALL | ✅ `/` | ❌ None |
| PostgreSQL | ❌ `postgres` | ❌ (data volume) | ⚠️ Platform-specific | ✅ `pg_isready` | ⚠️ Env vars only |
| Redis | ❌ `redis` | ❌ (data volume) | ⚠️ Platform-specific | ✅ `redis-cli ping` | ⚠️ None |

## Documented Exceptions

### PostgreSQL Container

**Exception:** Runs as `postgres` user (non-root but database-specific)  
**Reason:** PostgreSQL requires specific user permissions for data directory operations  
**Mitigation:**
- Uses `security_opt: no-new-privileges:true` to prevent privilege escalation
- Data directory mounted as volume, not in image layers
- Database credentials passed via environment variables, not baked into image
- Network access restricted to internal container network

**Configuration:**
```yaml
services:
  db:
    image: postgres:15-alpine
    security_opt:
      - "no-new-privileges:true"
    # Requires writable data directory for database operations
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

### Redis Container

**Exception:** Runs as default Redis user (non-root but service-specific)  
**Reason:** Redis requires writable data directory for persistence  
**Mitigation:**
- Uses `security_opt: no-new-privileges:true` to prevent privilege escalation
- Data directory mounted as volume, not in image layers
- No authentication required in internal network (external access blocked)
- Persistence disabled in production: `--save "" --appendonly no`

**Configuration:**
```yaml
services:
  redis:
    image: redis:7-alpine
    security_opt:
      - "no-new-privileges:true"
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    volumes:
      - redis_data:/data
```

### Indexer Migration Runtime

**Exception:** Requires writable `/app/prisma` during `prisma migrate deploy`  
**Reason:** Prisma migrations need write access to generate migration files  
**Mitigation:**
- Mounted as tmpfs in production compose file
- Migration runs once at startup, then process becomes read-only
- Migration scripts validated in CI before deployment
- No user data written during migrations

**Configuration:**
```yaml
services:
  indexer:
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
      - /app/prisma:size=32m,mode=1777  # Migration exception
```

### Frontend Build Artifacts

**Exception:** Next.js requires writable `/tmp` and `.next/cache` during startup  
**Reason:** Next.js generates cache files and temporary build artifacts  
**Mitigation:**
- Mounted as tmpfs in production compose file
- Cache files are non-sensitive and can be recreated
- No secrets written to cache directories
- Filesystem becomes read-only after startup

**Configuration:**
```yaml
services:
  frontend:
    read_only: true
    tmpfs:
      - /tmp:size=128m,mode=1777
      - /app/.next/cache:size=64m,mode=1777  # Cache exception
```

## Deployment Guidance

### Development Environment

Use base `docker-compose.yml` files without production hardening for local development:

```bash
# Indexer development
cd indexer
docker compose up -d

# Frontend development
cd frontend/elcarehub-app
docker compose up -d
```

### Staging Environment

Apply production hardening for staging to test security measures:

```bash
# Indexer staging
cd indexer
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Frontend staging
cd frontend/elcarehub-app
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Production Environment

**Required:** Always use production hardening configuration

```bash
# Indexer production
cd indexer
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Frontend production
cd frontend/elcarehub-app
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Environment Variables

**Never bake secrets into Docker images.** Always pass secrets via:

1. **Environment variables** (for container orchestration)
2. **Secrets manager** (Kubernetes secrets, AWS Secrets Manager, etc.)
3. **CI/CD variable injection** (during build process only for public env vars)

**Required Environment Variables:**

#### Indexer
```bash
# Database (use secrets manager in production)
DATABASE_URL=postgresql://user:pass@host:5432/db

# Redis (use secrets manager in production)
REDIS_URL=redis://host:6379

# Stellar configuration (public)
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Contract IDs (public)
MARKETPLACE_CONTRACT_ID=GD...
LAUNCHPAD_CONTRACT_ID=GD...

# Security tokens (use secrets manager)
HEALTH_DETAILS_TOKEN=random-secret-token
```

#### Frontend
```bash
# Public configuration (baked into build)
NEXT_PUBLIC_CONTRACT_ID=GD...
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_INDEXER_URL=https://api.elcarehub.xyz

# Sentry configuration (use secrets manager)
SENTRY_ORG=your-org
SENTRY_PROJECT=your-project
```

### Base Image Pinning

For production deployments, pin base images to specific digests for reproducibility:

```bash
# Get current digest
docker pull node:20-alpine
docker inspect node:20-alpine --format '{{index .RepoDigests 0}}'

# Update Dockerfile FROM lines
FROM node:20-alpine@sha256:<digest> AS builder
FROM node:20-alpine@sha256:<digest> AS runtime
```

**Schedule:** Review and update base image digests monthly.

## Vulnerability Scanning

### Pre-Deployment Scanning

Scan images before deployment to production:

```bash
# Using Trivy
trivy image elcarehub-indexer:latest
trivy image elcarehub-frontend:latest

# Using Docker Scout
docker scout quickview elcarehub-indexer:latest
docker scout quickview elcarehub-frontend:latest
```

### Scanning Thresholds

**Fail deployment if:**
- Critical vulnerabilities: > 0
- High vulnerabilities: > 0
- Medium vulnerabilities: > 5

**Exceptions require:**
- Security team approval
- Documented mitigation plan
- Timeline for remediation

### CI/CD Integration

Add scanning to CI pipeline:

```yaml
# .github/workflows/docker-scan.yml
name: Docker Image Scanning
on: [push, pull_request]

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build images
        run: docker build -t elcarehub-indexer ./indexer
      - name: Scan with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: elcarehub-indexer
          format: 'sarif'
          output: 'trivy-results.sarif'
      - name: Upload results
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: 'trivy-results.sarif'
```

## Testing Hardened Configuration

### Local Testing

Test hardened configuration locally before deployment:

```bash
# Build hardened images
cd indexer
docker compose -f docker-compose.yml -f docker-compose.prod.yml build

# Test startup
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Verify non-root user
docker compose exec indexer whoami
# Expected output: appuser

# Verify read-only filesystem
docker compose exec indexer touch /test.txt
# Expected: Touch: cannot touch '/test.txt': Read-only file system

# Verify capabilities dropped
docker compose exec indexer capsh --print
# Expected: Current capabilities: none

# Check health status
docker compose ps
# Expected: All services show "healthy"
```

### Health Check Validation

Verify health checks are functioning:

```bash
# Indexer health
curl http://localhost:4000/health
# Expected: {"status":"ok",...}

# Frontend health
curl http://localhost:3000/
# Expected: 200 OK response
```

### Graceful Shutdown Testing

Test graceful shutdown with SIGTERM:

```bash
# Start containers
docker compose up -d

# Send SIGTERM
docker compose stop indexer

# Verify graceful shutdown
docker compose logs indexer
# Expected: "SIGTERM received, shutting down gracefully"
```

## Troubleshooting

### Permission Denied Errors

**Symptom:** Container fails to start with permission errors

**Solutions:**
1. Check tmpfs mounts are properly configured
2. Verify volume permissions for data directories
3. Ensure non-root user has proper ownership

```bash
# Check volume permissions
docker volume inspect postgres_data
docker volume inspect redis_data

# Fix permissions if needed
docker compose down
docker volume rm postgres_data redis_data
docker compose up -d
```

### Health Check Failures

**Symptom:** Container marked as unhealthy despite running

**Solutions:**
1. Increase health check timeout/start-period
2. Verify health endpoint is accessible from within container
3. Check firewall rules don't block localhost access

```bash
# Test health check from inside container
docker compose exec indexer wget -qO- http://localhost:4000/health

# Adjust health check if needed
# In docker-compose.yml, increase start_period or timeout
```

### Read-Only Filesystem Issues

**Symptom:** Application fails to write required files

**Solutions:**
1. Identify required write paths using application logs
2. Add appropriate tmpfs mounts for those paths
3. Consider if the write operation is necessary or can be redesigned

```bash
# Find write attempts
docker compose logs indexer | grep -i "permission\|write\|eacces"

# Add tmpfs mount for identified path
# In docker-compose.prod.yml
tmpfs:
  - /identified/path:size=32m,mode=1777
```

## Maintenance

### Monthly Tasks

1. **Base Image Updates**
   - Check for security updates to base images
   - Update pinned digests if new versions available
   - Rebuild and test containers
   - Scan for new vulnerabilities

2. **Vulnerability Scanning**
   - Run full vulnerability scan on all images
   - Review and remediate any new findings
   - Update scanning thresholds if needed

3. **Configuration Review**
   - Review security exceptions for continued validity
   - Update documentation if exceptions change
   - Test hardened configuration after any changes

### Quarterly Tasks

1. **Security Audit**
   - Comprehensive review of all container configurations
   - Validate compliance with security standards
   - Update hardening measures based on new threats

2. **Performance Testing**
   - Test hardened configuration under load
   - Measure impact of security measures on performance
   - Optimize if significant performance degradation found

## References

- [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)
- [Docker Security Best Practices](https://docs.docker.com/engine/security/)
- [Kubernetes Security Best Practices](https://kubernetes.io/docs/concepts/security/security-context/)
- [OCI Image Specification](https://github.com/opencontainers/image-spec)

## Change History

| Date | Change | Author |
|------|--------|--------|
| 2026-08-25 | Initial hardening guide | Devin |
| 2026-08-25 | Added frontend Docker hardening | Devin |