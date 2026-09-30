# @elcarehub/config

Centralized, validated configuration for ELCARE-HUB components.

## Features

- **Zod-based schema validation** for all environment variables
- **Cross-component consistency checks** (network passphrase, contract IDs)
- **Safe error messages** that don't leak secrets
- **Runtime type inference** for TypeScript

## Installation

```bash
npm install zod @elcarehub/config
```

## Usage

```typescript
import { loadConfig, ValidationError } from '@elcarehub/config';

try {
  const config = loadConfig();
  console.log(config.networkPassphrase);
  console.log(config.marketplaceContractId);
} catch (err) {
  if (err instanceof ValidationError) {
    console.error('Configuration error:', err.message);
    process.exit(1);
  }
  throw err;
}
```

## Configuration Fields

### Network Configuration
| Field | Environment Variable | Description |
|-------|---------------------|-------------|
| `network` | `STELLAR_NETWORK` | "testnet" or "mainnet" |
| `rpcUrl` | `STELLAR_RPC_URL` | Soroban RPC endpoint URL |
| `horizonUrl` | `STELLAR_HORIZON_URL` | Horizon REST API URL |
| `networkPassphrase` | `STELLAR_NETWORK_PASSPHRASE` | Network passphrase |

### Contract Configuration
| Field | Environment Variable | Description |
|-------|---------------------|-------------|
| `marketplaceContractId` | `MARKETPLACE_CONTRACT_ID` | 56-char contract address starting with "C" |
| `launchpadContractId` | `LAUNCHPAD_CONTRACT_ID` | Optional 56-char contract address |

### Indexer Configuration
| Field | Environment Variable | Description |
|-------|---------------------|-------------|
| `indexerUrl` | `INDEXER_URL` | Indexer HTTP API URL |
| `operatorToken` | `OPERATOR_TOKEN` | Admin API authentication (≥32 chars) |
| `operatorAllowlist` | `OPERATOR_ALLOWLIST` | Comma-separated IP allowlist |

### Database Configuration
| Field | Environment Variable | Description |
|-------|---------------------|-------------|
| `databaseUrl` | `DATABASE_URL` | PostgreSQL connection string |
| `redisUrl` | `REDIS_URL` | Redis connection string |

### IPFS Configuration
| Field | Environment Variable | Description |
|-------|---------------------|-------------|
| `pinataGateway` | `PINATA_GATEWAY` | Pinata gateway URL |
| `pinataJwt` | `PINATA_JWT` | Pinata API key (optional) |

### Keeper Configuration
| Field | Environment Variable | Description |
|-------|---------------------|-------------|
| `keeperEnabled` | `KEEPER_ENABLED` | Enable keeper loop |
| `keeperDryRun` | `KEEPER_DRY_RUN` | Dry-run mode (no broadcasts) |
| `keeperSecret` | `KEEPER_SECRET` | Keeper account secret key |

## Cross-Component Consistency Checks

The config module performs the following safety validations:

1. **Network passphrase matches selected network**
   - `testnet` → "Test SDF Network ; September 2015"
   - `mainnet` → "Public Global Stellar Network ; September 2015"

2. **Contract IDs are properly formatted**
   - Exactly 56 characters
   - Start with "C" (Stellar Soroban format)

3. **Operator token minimum length**
   - At least 32 characters for security

4. **IP allowlist format validation**
   - Valid IPv4 or IPv6 addresses

## Error Messages

All error messages are descriptive and never leak secrets:

```
[NETWORK] Network passphrase mismatch. 
STELLAR_NETWORK="testnet" requires passphrase "Test SDF Network ; September 2015", 
but STELLAR_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015".

[CONTRACT] MARKETPLACE_CONTRACT_ID must be exactly 56 characters. 
Current length: 55. Expected format: C... (Stellar Soroban contract address).

[INDEXER] OPERATOR_TOKEN must be at least 32 characters for security. 
Generate with: openssl rand -hex 32
```

## Redacted Diagnostics

When configuration loads successfully, the module logs redacted information:

```
[CONFIG] Configuration loaded successfully
  Network: testnet
  RPC: soroban-testnet.stellar.org
  Indexer URL: localhost
  Marketplace Contract: C1234567...
  Launchpad Contract: C8901234...
```

No secrets (tokens, passwords, keys) are logged.

## Development

```bash
cd packages/config
npm install
npm test
npm run build
```

## Type Inference

The module exports TypeScript types:

```typescript
import { Config, ComponentConfig } from '@elcarehub/config';

// Full config type
const config: Config = loadConfig();

// Subsets for component-specific validation
type NetworkConfig = Pick<Config, 'network' | 'rpcUrl' | 'networkPassphrase'>;
```
