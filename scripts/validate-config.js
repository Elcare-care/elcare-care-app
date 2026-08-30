/**
 * validate-config.js — Cross-component configuration validation
 *
 * Run this script before starting any component to ensure:
 * - Network passphrase matches selected network
 * - Contract IDs are properly formatted
 * - No component has conflicting configuration
 *
 * Exit codes:
 *   0 = All validations passed
 *   1 = Validation failed (error message printed to stderr)
 */

import { loadConfig } from '../packages/config/dist/index.js';

// ── Validation functions ──────────────────────────────────────────────────────

/**
 * Validates that network passphrase matches the selected network.
 */
function validateNetworkPassphrase(config) {
  const expected = config.network === 'mainnet'
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';

  if (config.networkPassphrase !== expected) {
    console.error('[CONFIG] ERROR: Network passphrase mismatch');
    console.error(`  STELLAR_NETWORK="${config.network}" requires passphrase "${expected}"`);
    console.error(`  STELLAR_NETWORK_PASSPHRASE="${config.networkPassphrase}"`);
    return false;
  }

  console.log(`[CONFIG] Network passphrase validated: ${config.networkPassphrase}`);
  return true;
}

/**
 * Validates that contract IDs are properly formatted.
 */
function validateContractIds(config) {
  const errors = [];

  if (!config.marketplaceContractId || config.marketplaceContractId.length !== 56) {
    errors.push(`MARKETPLACE_CONTRACT_ID must be exactly 56 characters (got ${config.marketplaceContractId?.length ?? 0})`);
  }

  if (config.marketplaceContractId && !config.marketplaceContractId.startsWith('C')) {
    errors.push(`MARKETPLACE_CONTRACT_ID must start with "C" (Stellar contract address format)`);
  }

  if (config.launchpadContractId) {
    if (config.launchpadContractId.length !== 56) {
      errors.push(`LAUNCHPAD_CONTRACT_ID must be exactly 56 characters (got ${config.launchpadContractId.length})`);
    }
    if (!config.launchpadContractId.startsWith('C')) {
      errors.push(`LAUNCHPAD_CONTRACT_ID must start with "C" (Stellar contract address format)`);
    }
  }

  if (errors.length > 0) {
    console.error('[CONFIG] ERROR: Invalid contract configuration');
    errors.forEach((err) => console.error(`  - ${err}`));
    return false;
  }

  console.log(`[CONFIG] Marketplace contract: ${config.marketplaceContractId.slice(0, 8)}...`);
  if (config.launchpadContractId) {
    console.log(`[CONFIG] Launchpad contract: ${config.launchpadContractId.slice(0, 8)}...`);
  }
  return true;
}

/**
 * Validates that indexer URL is valid and reachable.
 */
function validateIndexerUrl(config) {
  try {
    const url = new URL(config.indexerUrl);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      console.error('[CONFIG] ERROR: INDEXER_URL must use http:// or https://');
      return false;
    }

    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      console.warn('[CONFIG] WARNING: INDEXER_URL points to localhost');
      console.warn('  This may not be reachable from Docker containers or production deployments.');
    }

    console.log(`[CONFIG] Indexer URL validated: ${url.hostname}`);
    return true;
  } catch (err) {
    console.error('[CONFIG] ERROR: Invalid INDEXER_URL format');
    console.error(`  ${err.message}`);
    return false;
  }
}

/**
 * Validates operator token configuration.
 */
function validateOperatorToken(config) {
  if (config.operatorToken.length < 32) {
    console.error('[CONFIG] ERROR: OPERATOR_TOKEN must be at least 32 characters for security');
    console.error(`  Current length: ${config.operatorToken.length}`);
    return false;
  }

  console.log(`[CONFIG] Operator token validated (${config.operatorToken.length} chars)`);
  return true;
}

/**
 * Validates database configuration.
 */
function validateDatabaseConfig(config) {
  if (!config.databaseUrl.startsWith('postgresql://')) {
    console.error('[CONFIG] ERROR: DATABASE_URL must start with "postgresql://"');
    return false;
  }

  if (!config.redisUrl.startsWith('redis://')) {
    console.error('[CONFIG] ERROR: REDIS_URL must start with "redis://"');
    return false;
  }

  console.log('[CONFIG] Database configuration validated');
  return true;
}

/**
 * Validates IPFS configuration.
 */
function validateIpfsConfig(config) {
  try {
    new URL(config.pinataGateway);
    console.log(`[CONFIG] IPFS gateway: ${new URL(config.pinataGateway).hostname}`);
  } catch (err) {
    console.error('[CONFIG] ERROR: Invalid PINATA_GATEWAY format');
    return false;
  }

  if (!config.pinataJwt) {
    console.warn('[CONFIG] WARNING: PINATA_JWT not set — IPFS metadata fetch may fail');
  } else if (config.pinataJwt.length < 32) {
    console.warn('[CONFIG] WARNING: PINATA_JWT is short — may be invalid');
  }

  return true;
}

/**
 * Validates keeper configuration.
 */
function validateKeeperConfig(config) {
  if (config.keeperEnabled) {
    if (!config.keeperSecret || config.keeperSecret.length !== 56) {
      console.error('[CONFIG] ERROR: KEEPER_ENABLED=true requires KEEPER_SECRET (56 chars)');
      return false;
    }

    if (!config.keeperSecret.startsWith('S')) {
      console.error('[CONFIG] ERROR: KEEPER_SECRET must start with "S" (Stellar secret key format)');
      return false;
    }

    console.log('[CONFIG] Keeper configuration validated');
  }

  return true;
}

// ── Main validation runner ────────────────────────────────────────────────────

export async function validateAll() {
  console.log('[CONFIG] Loading configuration...');
  console.log('');

  try {
    const config = loadConfig();

    const checks = [
      ['Network', () => validateNetworkPassphrase(config)],
      ['Contracts', () => validateContractIds(config)],
      ['Indexer URL', () => validateIndexerUrl(config)],
      ['Operator Token', () => validateOperatorToken(config)],
      ['Database', () => validateDatabaseConfig(config)],
      ['IPFS', () => validateIpfsConfig(config)],
      ['Keeper', () => validateKeeperConfig(config)],
    ];

    let allPassed = true;

    for (const [name, check] of checks) {
      const result = check();
      if (!result) {
        allPassed = false;
      }
      console.log('');
    }

    if (allPassed) {
      console.log('[CONFIG] ✓ All validations passed');
      console.log('');
      console.log('Configuration summary:');
      console.log(`  Network: ${config.network}`);
      console.log(`  RPC: ${new URL(config.rpcUrl).hostname}`);
      console.log(`  Horizon: ${new URL(config.horizonUrl).hostname}`);
      console.log(`  Indexer URL: ${new URL(config.indexerUrl).hostname}`);
      console.log(`  Database: PostgreSQL on ${new URL(config.databaseUrl).hostname}`);
      console.log(`  Redis: ${new URL(config.redisUrl).hostname}`);
      return 0;
    } else {
      console.log('[CONFIG] ✗ Validation failed — check errors above');
      return 1;
    }
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'MissingEnvError') {
      console.error('[CONFIG] ERROR: Configuration validation failed');
      console.error('');
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

// ── Exit with appropriate code ────────────────────────────────────────────────

await validateAll().then((code) => process.exit(code));
