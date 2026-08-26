# Docker Hardening Test Procedures

## Overview

This document outlines the testing procedures for validating Docker hardening measures. These tests should be run in an environment where Docker is available before deploying hardened configurations to production.

## Pre-Test Requirements

### Prerequisites
- Docker installed and running
- Docker Compose installed
- Access to the repository
- Sufficient disk space for building images

### Environment Setup
```bash
# Clone repository (if not already done)
git clone <repository-url>
cd elcare-care-app

# Set environment variables
cp indexer/.env.example indexer/.env
cp frontend/elcarehub-app/.env.example frontend/elcarehub-app/.env
```

## Indexer Hardening Tests

### Test 1: Build Indexer Image
```bash
cd indexer
docker build -t elcarehub-indexer:test .
```

**Expected Result:** Image builds successfully without errors

### Test 2: Non-Root User Verification
```bash
# Start container with base configuration
docker compose up -d

# Verify non-root user
docker compose exec indexer whoami
```

**Expected Result:** Output shows `appuser`

### Test 3: Capability Dropping Verification
```bash
# Check capabilities from inside container
docker compose exec indexer capsh --print
```

**Expected Result:** Current capabilities show `none` or minimal set

### Test 4: Read-Only Filesystem (Production)
```bash
# Start with production hardening
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Attempt to write to filesystem
docker compose exec indexer touch /test.txt
```

**Expected Result:** Permission denied error (read-only filesystem)

### Test 5: Health Check Functionality
```bash
# Check health status
docker compose ps

# Test health endpoint
docker compose exec indexer wget -qO- http://localhost:4000/health
```

**Expected Result:** Container shows as healthy, health endpoint returns 200 OK

### Test 6: Privilege Escalation Prevention
```bash
# Check security options
docker inspect indexer | grep -A 10 SecurityOpt
```

**Expected Result:** Shows `no-new-privileges:true`

### Test 7: Migration Write Path
```bash
# Test that migrations can run with tmpfs mount
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose logs indexer | grep -i migration
```

**Expected Result:** Migrations complete successfully without permission errors

## Frontend Hardening Tests

### Test 1: Build Frontend Image
```bash
cd frontend/elcarehub-app
docker build -t elcarehub-frontend:test .
```

**Expected Result:** Image builds successfully without errors

### Test 2: Non-Root User Verification
```bash
# Start container
docker compose up -d

# Verify non-root user
docker compose exec frontend whoami
```

**Expected Result:** Output shows `appuser`

### Test 3: Capability Dropping Verification
```bash
# Check capabilities
docker compose exec frontend capsh --print
```

**Expected Result:** Current capabilities show `none` or minimal set

### Test 4: Read-Only Filesystem (Production)
```bash
# Start with production hardening
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Attempt to write to filesystem
docker compose exec frontend touch /test.txt
```

**Expected Result:** Permission denied error (read-only filesystem)

### Test 5: Health Check Functionality
```bash
# Check health status
docker compose ps

# Test health endpoint
docker compose exec frontend wget -qO- http://localhost:3000/api/health
```

**Expected Result:** Container shows as healthy, health endpoint returns 200 OK

### Test 6: Tmpfs Mount Verification
```bash
# Check tmpfs mounts
docker inspect frontend | grep -A 5 Tmpfs
```

**Expected Result:** Shows `/tmp` and `/app/.next/cache` tmpfs mounts

### Test 7: Graceful Shutdown
```bash
# Start container
docker compose up -d

# Send SIGTERM
docker compose stop frontend

# Check logs for graceful shutdown
docker compose logs frontend
```

**Expected Result:** Logs show graceful shutdown message, no error crashes

## Vulnerability Scanning Tests

### Test 1: Trivy Scan
```bash
# Scan indexer image
trivy image elcarehub-indexer:test

# Scan frontend image
trivy image elcarehub-frontend:test
```

**Expected Result:** 
- Critical vulnerabilities: 0
- High vulnerabilities: 0
- Medium vulnerabilities: ≤ 5

### Test 2: Docker Scout Scan
```bash
# Quick vulnerability scan
docker scout quickview elcarehub-indexer:test
docker scout quickview elcarehub-frontend:test
```

**Expected Result:** No critical or high severity vulnerabilities

## Integration Tests

### Test 1: Full Stack Startup
```bash
# Start all services with production hardening
cd indexer
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

cd ../frontend/elcarehub-app
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Expected Result:** All services start successfully and become healthy

### Test 2: Inter-Service Communication
```bash
# Test frontend can reach indexer
docker compose exec frontend wget -qO- http://indexer:4000/health
```

**Expected Result:** Successful health check response

### Test 3: Database Operations
```bash
# Test indexer can perform database operations
docker compose exec indexer npx prisma db push --skip-generate
```

**Expected Result:** Database operations complete successfully

## Performance Impact Tests

### Test 1: Startup Time Comparison
```bash
# Measure startup time without hardening
time docker compose up -d
docker compose down

# Measure startup time with hardening
time docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Expected Result:** Startup time increase < 20% with hardening

### Test 2: Resource Usage
```bash
# Monitor resource usage during normal operation
docker stats
```

**Expected Result:** Resource usage within acceptable limits

## Cleanup

```bash
# Stop all containers
cd indexer
docker compose -f docker-compose.yml -f docker-compose.prod.yml down

cd ../frontend/elcarehub-app
docker compose -f docker-compose.yml -f docker-compose.prod.yml down

# Remove test images
docker rmi elcarehub-indexer:test elcarehub-frontend:test
```

## Test Results Template

Use this template to document test results:

```markdown
## Docker Hardening Test Results

**Date:** [DATE]
**Tester:** [NAME]
**Environment:** [ENVIRONMENT]

### Indexer Tests
- [ ] Build successful
- [ ] Non-root user verified
- [ ] Capabilities dropped
- [ ] Read-only filesystem (production)
- [ ] Health check functional
- [ ] Privilege escalation prevented
- [ ] Migration write path working

### Frontend Tests
- [ ] Build successful
- [ ] Non-root user verified
- [ ] Capabilities dropped
- [ ] Read-only filesystem (production)
- [ ] Health check functional
- [ ] Tmpfs mounts verified
- [ ] Graceful shutdown working

### Vulnerability Scans
- [ ] Trivy scan passed (Indexer)
- [ ] Trivy scan passed (Frontend)
- [ ] Docker scout scan passed (Indexer)
- [ ] Docker scout scan passed (Frontend)

### Integration Tests
- [ ] Full stack startup successful
- [ ] Inter-service communication working
- [ ] Database operations functional

### Performance Tests
- [ ] Startup time acceptable
- [ ] Resource usage acceptable

### Issues Found
- [Issue description]
- [Remediation steps]

### Overall Result
- [ ] PASS - All tests passed
- [ ] FAIL - Issues require remediation
```

## Sign-Off Criteria

Docker hardening is considered complete when:

1. ✅ All containers run as non-root users
2. ✅ All production containers use read-only filesystems (with documented exceptions)
3. ✅ All Linux capabilities are dropped (with documented exceptions)
4. ✅ No secrets are baked into image layers
5. ✅ Health checks are functional for all services
6. ✅ Vulnerability scans meet baseline thresholds
7. ✅ Graceful shutdown works correctly
8. ✅ All documented exceptions are justified and mitigated
9. ✅ Performance impact is acceptable (< 20% startup time increase)
10. ✅ Documentation is complete and accurate

## References

- [Docker Hardening Guide](./docker-hardening.md)
- [Deployment Guide](./deployment.md)
- [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)