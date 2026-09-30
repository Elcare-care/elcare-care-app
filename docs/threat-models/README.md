# Threat Model Records

This directory contains completed threat-model records for contract changes.

Each file follows the naming convention:

```
TM-YYYY-MM-DD-short-description.md
```

Every PR that modifies files under `contracts/` must add a record here before merging.
The CI gate in `.github/workflows/contract-threat-model-gate.yml` enforces this.

Use `docs/threat-model-template.md` as the starting point for each new record.
