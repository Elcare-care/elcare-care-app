## Summary

<!-- What does this change do? Why? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] Contract change
- [ ] Infrastructure / deployment

---

## 🔐 High-Risk Change Assessment

Does this PR modify any of the following?

- [ ] Contract entry points, storage, or events (`contracts/`)
- [ ] Authorization or role-based access control
- [ ] Financial calculations (settlement, royalties, fees)
- [ ] Wallet signing or transaction simulation
- [ ] Database migrations (`prisma/schema.prisma`)
- [ ] Event parser or schema changes (`indexer/src/event-parser.ts`, `event-catalog.ts`)

**If you checked ANY box above**, use the **[High-Risk Change Template](.github/PULL_REQUEST_TEMPLATE/high_risk_change.md)** instead. Close this PR and reopen with the high-risk template.

---

## Testing

- [ ] Unit / integration tests pass (`cargo test`, `npm test`)
- [ ] E2E tests pass (`npm run test:e2e`)
- [ ] Manual testing performed (describe below)

Manual test steps:

---

## Related issues

<!-- Closes #, Fixes # -->

## Release notes

<!-- What should appear in CHANGELOG.md for this change? -->
