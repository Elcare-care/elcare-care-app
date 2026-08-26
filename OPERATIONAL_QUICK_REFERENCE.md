# Operational Runbook Quick Reference

Fast access to all documented procedures for token onboarding, contract upgrades, indexer consumption, and accessibility conformance.

---

## Token Onboarding

**Runbook:** `docs/runbooks/token-onboarding.md`

### Preflight check
```bash
bash scripts/preflight/token-onboarding.sh \
  --address CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX \
  --symbol USDC \
  --decimals 7 \
  --network testnet
```

### Admin UI
- Navigate to `/admin` → Token Whitelist
- Use `TokenWhitelistControl` component
- All verification checklist items must be checked before submit

### CLI (direct contract call)
```bash
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --network testnet \
  --source admin \
  -- add_token_to_whitelist \
     --admin "$ADMIN_ADDRESS" \
     --token "$TOKEN_ADDRESS"
```

### Verify on-chain
```bash
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --network testnet \
  -- get_token_whitelist
```

### Verify indexer
```bash
curl -s "http://localhost:4000/tokens" | jq '.[] | select(.address=="'$TOKEN_ADDRESS'")'
```

### Revocation (emergency)
Same as add, but use `remove_token_from_whitelist`. See §7 for effects on existing listings.

---

## Contract Upgrade & Migration

**Runbook:** `docs/guides/contract-upgrade-runbook.md`

### Rehearsal (dry-run on testnet)
```bash
bash scripts/rehearse/contract-upgrade-rehearsal.sh \
  --contract soroban-marketplace \
  --network testnet \
  --wasm target/wasm32v1-none/release/soroban_marketplace.wasm
```

### Build WASM
```bash
cargo build --target wasm32v1-none --release -p soroban-marketplace
```

### Upload WASM
```bash
stellar contract upload \
  --wasm target/wasm32v1-none/release/soroban_marketplace.wasm \
  --network testnet \
  --source admin
# Copy the 32-byte hash from output
```

### Install WASM
```bash
stellar contract install \
  --wasm-hash <new-wasm-hash> \
  --contract-id <contract-address> \
  --network testnet \
  --source admin
```

### Run migration (unbounded)
```bash
stellar contract invoke \
  --id <contract-address> \
  --network testnet \
  --source admin \
  -- migrate \
     --admin <admin-address>
```

### Run migration (bounded, resumable)
```bash
while true; do
  REMAINING=$(stellar contract invoke \
    --id <contract-address> --network testnet --source admin \
    -- migrate_step --admin <admin-address> --max_items 200 2>&1 | tail -1)
  echo "Remaining: $REMAINING"
  [ "$REMAINING" -eq 0 ] && break
  sleep 2
done
```

### Verify post-upgrade
```bash
# Version match
stellar contract invoke --id <contract-address> --network testnet -- version
stellar contract invoke --id <contract-address> --network testnet -- contract_version

# Event emitted
stellar events --contract-id <contract-address> --network testnet --topic1 migrated

# State spot-check (marketplace)
stellar contract invoke --id <marketplace> --network testnet -- get_active_listings_count
```

---

## Indexer Consumer Patterns

**Guide:** `docs/guides/indexer-consumer-guide.md`  
**Example:** `frontend/elcarehub-app/src/lib/indexer-consumer-example.ts`  
**Fixtures:** `indexer/src/__tests__/consumer-guide-fixtures.ts`

### Version check
```bash
curl -sI http://localhost:4000/listings | grep -i x-api-version
```

### Paginated list with rate limits
```bash
curl -s "http://localhost:4000/listings?page=1&limit=20" | jq '.[] | {listingId, priceDecimal, token}'
```

### Conditional GET (ETag)
```bash
ETAG=$(curl -sI http://localhost:4000/listings/42 | grep -i etag | awk '{print $2}' | tr -d '\r')
curl -s -H "If-None-Match: $ETAG" -w "\nHTTP %{http_code}\n" http://localhost:4000/listings/42
```

### SSE subscription (5 s sample)
```bash
curl -N -m 5 -H "Accept: text/event-stream" http://localhost:4000/events
```

### SSE with cursor resume
```bash
curl -N -H "Last-Event-ID: 1042" http://localhost:4000/events
```

### Operator call (server-side only)
```bash
curl -s -H "Authorization: Bearer $OPERATOR_TOKEN" \
  http://localhost:4000/admin/sync-status
```

### BigInt handling (TypeScript)
```typescript
// ✓ Correct
const price = BigInt("100000000");
const display = (price / BigInt(10 ** 7)).toString();

// ✗ Wrong
const price = parseFloat("100000000"); // loses precision
```

### Retry with backoff
```typescript
// See IndexerConsumer.retryGet() in indexer-consumer-example.ts
// Exponential backoff: 500ms → 1s → 2s (cap 30s)
// Honor Retry-After header
```

---

## Accessibility Conformance

**Statement:** `docs/accessibility/ACCESSIBILITY.md`  
**Fixtures:** `frontend/elcarehub-app/src/__tests__/a11y/fixtures.ts`

### Unit a11y tests (jest-axe)
```bash
cd frontend/elcarehub-app && npm run test:a11y
```

### E2E a11y scan
```bash
cd frontend/elcarehub-app && npm run test:e2e -- tests/e2e/a11y.spec.ts
```

### Keyboard walkthrough
```bash
cd frontend/elcarehub-app && npm run test:e2e -- tests/e2e/a11y-keyboard.spec.ts
```

### Manual audit checklist
- [ ] Keyboard navigation (Tab, Arrow, Escape, Enter)
- [ ] Focus indicators visible
- [ ] Screen reader (NVDA + Firefox, VoiceOver + Safari)
- [ ] Color contrast ≥ 4.5:1 (normal), ≥ 3:1 (large)
- [ ] Reduced motion respected (`prefers-reduced-motion: reduce`)
- [ ] Error messages clear and associated with fields
- [ ] Live regions announce dynamic updates

### Verify reduced motion CSS
```bash
grep -r "prefers-reduced-motion" frontend/elcarehub-app/src --include="*.css" --include="*.tsx"
```

### Check aria-live regions
```bash
grep -r "aria-live" frontend/elcarehub-app/src --include="*.tsx"
```

---

## CI & Release Gates

### Validate compatibility
```bash
bash scripts/validate-compatibility.sh
```

### Check OpenAPI
```bash
bash scripts/check-openapi.sh
```

### Run all indexer tests
```bash
npm run test:indexer
```

### Run all frontend tests
```bash
cd frontend/elcarehub-app && npm run test
```

---

## Related Documents

- [Token Onboarding Runbook](docs/runbooks/token-onboarding.md)
- [Payment Tokens Guide](docs/guides/payment-tokens.md)
- [Contract Upgrade Runbook](docs/guides/contract-upgrade-runbook.md)
- [Indexer Consumer Guide](docs/guides/indexer-consumer-guide.md)
- [Accessibility Statement](docs/accessibility/ACCESSIBILITY.md)
- [Financial Reconciliation](docs/financial-reconciliation-runbook.md)
- [SSE Protocol](docs/sse-protocol.md)
- [Reorganization Runbook](docs/runbooks/reorganization.md)

---

## Support

For issues or questions:
1. Check the relevant runbook or guide
2. Review test fixtures for examples
3. Open an issue with `runbook` or `a11y` label
4. Contact: operations@elcarehub.io (placeholder)
