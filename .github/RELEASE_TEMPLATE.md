## Release Checklist

Copy this template for each release. Fill in all sections before tagging.

### Version Declarations

- [ ] Update `versions.toml`:
  - [ ] Bump `release_id`
  - [ ] Update `[components.contracts.marketplace]` version
  - [ ] Update `[components.contracts.launchpad]` version
  - [ ] Update `[components.indexer]` version and `db_migration_version`
  - [ ] Update `[components.frontend]` version
  - [ ] Update `[components.event_schema]` version (if event fields changed)
  - [ ] Add new entry to `[compatibility].valid_combinations`
- [ ] Update `indexer/package.json` → `version`
- [ ] Update `frontend/elcarehub-app/package.json` → `version`
- [ ] Update `contracts/soroban-marketplace/Cargo.toml` → `version` (if changed)
- [ ] Update `contracts/launchpad/Cargo.toml` → `version` (if changed)
- [ ] Update `indexer/openapi.json` → `info.version` (if API changed)

### Compatibility Validation

- [ ] Run `bash scripts/validate-compatibility.sh` — all checks pass
- [ ] All CI jobs pass: contracts, frontend, indexer, e2e, integration
- [ ] Event catalog check passes (`npx vitest src/__tests__/event-catalog.test.ts --run`)
- [ ] OpenAPI spec is in sync (`npm run check-openapi` in indexer)
- [ ] Database migration applies cleanly on fresh DB
- [ ] Database migration applies cleanly on upgrade from previous version
- [ ] Frontend production build succeeds (`npm run build`)
- [ ] Contract WASM builds and passes all tests (`cargo test`)

### Documentation

- [ ] Update `CHANGELOG.md` with this release entry
- [ ] Update `COMPATIBILITY.md` matrix (add new row, update versions)
- [ ] Document required migrations in CHANGELOG.md
- [ ] Document rollback procedure in CHANGELOG.md
- [ ] Note any breaking changes for API consumers or event parsers
- [ ] Update `docs/guides/deployment.md` if deployment process changed
- [ ] If contract files were changed: threat-model record exists in `docs/threat-models/` and independent reviewer has signed off

### Deployment

- [ ] Tag release: `git tag -a v<release_id> -m "Release <release_id> — <summary>"`
- [ ] Build Docker image: `docker build -t elcarehub-indexer:v<version> indexer/`
- [ ] Push Docker image to registry
- [ ] Deploy contracts (if changed): `bash scripts/deploy/deploy_contract.sh`
- [ ] Deploy indexer: `kubectl rollout restart deployment/indexer`
- [ ] Frontend deploys via Vercel (automatic on merge to main)
- [ ] Verify `/health/details` returns correct component versions
- [ ] Verify frontend footer shows correct version
- [ ] Verify API response headers include version metadata

### Post-Deploy Verification

- [ ] Smoke test: create listing, buy artwork, verify events parsed correctly
- [ ] Check Grafana dashboard for anomalies
- [ ] Verify Sentry error rate is baseline
- [ ] Confirm no new unknown event types in indexer logs
