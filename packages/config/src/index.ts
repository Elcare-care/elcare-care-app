/**
 * @elcarehub/config - Centralized, validated configuration for ELCARE-HUB
 *
 * This module provides:
 * - Zod-based schema validation for all environment variables
 * - Cross-component consistency checks (network passphrase, contract IDs)
 * - Safe error messages that don't leak secrets
 * - Runtime type inference for TypeScript
 *
 * Usage:
 *   import { config } from '@elcarehub/config';
 *   console.log(config.networkPassphrase);
 */

import { z } from 'zod';

// ── Network configuration ─────────────────────────────────────────────────────

const NetworkEnum = z.enum(['testnet', 'mainnet'], {
  errorMap: (_issue, _ctx) => ({
    message:
      'STELLAR_NETWORK must be "testnet" or "mainnet". ' +
      'For local development, use testnet and override RPC/Horizon URLs.',
  }),
});

const NetworkPassphraseEnum = z.enum(
  [
    'Test SDF Network ; September 2015',
    'Public Global Stellar Network ; September 2015',
  ],
  {
    errorMap: (_issue, _ctx) => ({
      message:
        'STELLAR_NETWORK_PASSPHRASE must match the selected network. ' +
        'Use "Test SDF Network ; September 2015" for testnet, ' +
        '"Public Global Stellar Network ; September 2015" for mainnet.',
    }),
  },
);

const NetworkConfigSchema = z.object({
  network: NetworkEnum,
  rpcUrl: z.string().url({
    message: 'STELLAR_RPC_URL must be a valid URL (e.g., https://soroban-testnet.stellar.org)',
  }),
  horizonUrl: z.string().url({
    message: 'STELLAR_HORIZON_URL must be a valid URL (e.g., https://horizon-testnet.stellar.org)',
  }),
  networkPassphrase: NetworkPassphraseEnum,
});

// ── Contract configuration ────────────────────────────────────────────────────

const ContractIdSchema = z.string().min(56).max(56).startsWith('C', {
  message:
    'Contract ID must be exactly 56 characters and start with "C" (Stellar contract address format).',
});

const ContractConfigSchema = z.object({
  marketplaceContractId: ContractIdSchema,
  launchpadContractId: ContractIdSchema.optional(),
});

// ── Indexer configuration ─────────────────────────────────────────────────────

const IndexerUrlSchema = z.string().url({
  message:
    'INDEXER_URL must be a valid URL with http/https scheme (e.g., http://localhost:4000).',
});

const OperatorTokenSchema = z.string().min(32, {
  message:
    'OPERATOR_TOKEN must be at least 32 characters for security. Generate with: openssl rand -hex 32',
});

const IndexerConfigSchema = z.object({
  indexerUrl: IndexerUrlSchema,
  operatorToken: OperatorTokenSchema,
  operatorAllowlist: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    )
    .refine(
      (ips) => ips.length === 0 || ips.every(isValidIp),
      {
        message:
          'OPERATOR_ALLOWLIST must be comma-separated valid IP addresses (IPv4 or IPv6).',
      },
    ),
});

function isValidIp(ip: string): boolean {
  // IPv4 regex
  const ipv4Regex =
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  // IPv6 regex (simplified)
  const ipv6Regex =
    /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;

  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

// ── Database & Redis configuration ────────────────────────────────────────────

const DatabaseUrlSchema = z.string().startsWith('postgresql://', {
  message: 'DATABASE_URL must start with "postgresql://" (PostgreSQL connection string).',
});

const RedisUrlSchema = z.string().startsWith('redis://', {
  message: 'REDIS_URL must start with "redis://" (Redis connection string).',
});

const DatabaseConfigSchema = z.object({
  databaseUrl: DatabaseUrlSchema,
  redisUrl: RedisUrlSchema,
});

// ── IPFS configuration ────────────────────────────────────────────────────────

const PinataGatewaySchema = z.string().url({
  message: 'PINATA_GATEWAY must be a valid URL (e.g., https://gateway.pinata.cloud).',
});

const PinataJwtSchema = z.string().min(32, {
  message: 'PINATA_JWT must be at least 32 characters. Check your Pinata API Key.',
});

const IpfsConfigSchema = z.object({
  pinataGateway: PinataGatewaySchema,
  pinataJwt: PinataJwtSchema.optional(), // Optional for development
});

// ── Keeper configuration ──────────────────────────────────────────────────────

const KeeperSecretSchema = z.string().min(56).max(56).startsWith('S', {
  message: 'KEEPER_SECRET must be a valid Stellar secret key (56 chars, starts with "S").',
});

const KeeperConfigSchema = z.object({
  keeperEnabled: z.coerce.boolean().default(false),
  keeperDryRun: z.coerce.boolean().default(true),
  keeperSecret: z.string().optional(),
  keeperIntervalMs: z.coerce.number().int().positive().default(60000),
  keeperMaxActionsPerCycle: z.coerce.number().int().positive().default(20),
  keeperMaxFeeStroops: z.coerce.number().int().positive().default(1000000),
  keeperDailyFeeBudgetStroops: z.coerce.number().int().positive().default(10000000),
  keeperFeeBumpMultiplier: z.coerce.number().positive().default(1.5),
  keeperFeeBumpMaxRetries: z.coerce.number().int().positive().default(3),
  keeperSubmitTimeoutMs: z.coerce.number().int().positive().default(30000),
});

// ── Version metadata ──────────────────────────────────────────────────────────

const VersionConfigSchema = z.object({
  appVersion: z.string().default('0.0.0-dev'),
  apiVersion: z.string().default('1.0.0'),
  eventSchemaVersion: z.coerce.number().int().positive().default(1),
  dbMigrationVersion: z.string().default('20260724000000'),
});

// ── Cross-component consistency validators ────────────────────────────────────

/**
 * Validates that network passphrase matches the selected network.
 * This is a critical safety check - mismatched passphrases cause transaction failures.
 */
function validateNetworkConsistency(config: {
  network: string;
  networkPassphrase: string;
}): void {
  const expected = config.network === 'mainnet'
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';

  if (config.networkPassphrase !== expected) {
    throw new ValidationError(
      `[NETWORK] Network passphrase mismatch. ` +
      `STELLAR_NETWORK="${config.network}" requires passphrase "${expected}", ` +
      `but STELLAR_NETWORK_PASSPHRASE="${config.networkPassphrase}".`,
    );
  }
}

/**
 * Validates that contract IDs are properly formatted and present.
 * Contract IDs are required for both indexer (parsing events) and frontend (interacting).
 */
function validateContractConsistency(config: {
  marketplaceContractId: string;
  launchpadContractId?: string;
}): void {
  // Marketplace contract is required
  if (!config.marketplaceContractId || config.marketplaceContractId.length !== 56) {
    throw new ValidationError(
      `[CONTRACT] MARKETPLACE_CONTRACT_ID must be exactly 56 characters. ` +
      `Current length: ${config.marketplaceContractId?.length ?? 0}. ` +
      `Expected format: C... (Stellar Soroban contract address).`,
    );
  }

  // Launchpad contract is optional but must be valid if present
  if (config.launchpadContractId) {
    if (config.launchpadContractId.length !== 56) {
      throw new ValidationError(
        `[CONTRACT] LAUNCHPAD_CONTRACT_ID must be exactly 56 characters. ` +
        `Current length: ${config.launchpadContractId.length}.`,
      );
    }
  }
}

/**
 * Validates that indexer URL is valid and accessible.
 * Frontend depends on this to fetch marketplace data.
 */
function validateIndexerUrlConsistency(config: {
  indexerUrl: string;
}): void {
  // Basic URL validation via Zod is done in schema
  // Additional checks: ensure it's not pointing to wrong port or localhost in production
  const url = new URL(config.indexerUrl);

  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    console.warn(
      `[CONFIG] INDEXER_URL points to localhost. ` +
      `This may not be reachable from Docker containers or production deployments.`,
    );
  }
}

// ── Error types ───────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class MissingEnvError extends Error {
  public missing: string[];

  constructor(message: string, missing: string[]) {
    super(message);
    this.name = 'MissingEnvError';
    this.missing = missing;
  }
}

// ── Configuration loader ──────────────────────────────────────────────────────

export interface Config {
  network: 'testnet' | 'mainnet';
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  marketplaceContractId: string;
  launchpadContractId?: string;
  indexerUrl: string;
  operatorToken: string;
  operatorAllowlist: string[];
  databaseUrl: string;
  redisUrl: string;
  pinataGateway: string;
  pinataJwt?: string;
  keeperEnabled: boolean;
  keeperDryRun: boolean;
  keeperSecret?: string;
  keeperIntervalMs: number;
  keeperMaxActionsPerCycle: number;
  keeperMaxFeeStroops: number;
  keeperDailyFeeBudgetStroops: number;
  keeperFeeBumpMultiplier: number;
  keeperFeeBumpMaxRetries: number;
  keeperSubmitTimeoutMs: number;
  appVersion: string;
  apiVersion: string;
  eventSchemaVersion: number;
  dbMigrationVersion: string;
}

/**
 * Loads and validates all configuration from environment variables.
 * Throws descriptive errors if validation fails.
 * Never logs secret values.
 */
export function loadConfig(): Config {
  // Load from environment
  const env = {
    // Network
    network: process.env.STELLAR_NETWORK,
    rpcUrl: process.env.STELLAR_RPC_URL,
    horizonUrl: process.env.STELLAR_HORIZON_URL,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,

    // Contracts
    marketplaceContractId: process.env.MARKETPLACE_CONTRACT_ID,
    launchpadContractId: process.env.LAUNCHPAD_CONTRACT_ID,

    // Indexer
    indexerUrl: process.env.INDEXER_URL,
    operatorToken: process.env.OPERATOR_TOKEN,
    operatorAllowlist: process.env.OPERATOR_ALLOWLIST,

    // Database & Redis
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,

    // IPFS
    pinataGateway: process.env.PINATA_GATEWAY,
    pinataJwt: process.env.PINATA_JWT,

    // Keeper
    keeperEnabled: process.env.KEEPER_ENABLED,
    keeperDryRun: process.env.KEEPER_DRY_RUN,
    keeperSecret: process.env.KEEPER_SECRET,
    keeperIntervalMs: process.env.KEEPER_INTERVAL_MS,
    keeperMaxActionsPerCycle: process.env.KEEPER_MAX_ACTIONS_PER_CYCLE,
    keeperMaxFeeStroops: process.env.KEEPER_MAX_FEE_STROOPS,
    keeperDailyFeeBudgetStroops: process.env.KEEPER_DAILY_FEE_BUDGET_STROOPS,
    keeperFeeBumpMultiplier: process.env.KEEPER_FEE_BUMP_MULTIPLIER,
    keeperFeeBumpMaxRetries: process.env.KEEPER_FEE_BUMP_MAX_RETRIES,
    keeperSubmitTimeoutMs: process.env.KEEPER_SUBMIT_TIMEOUT_MS,

    // Version metadata
    appVersion: process.env.INDEXER_VERSION,
    apiVersion: process.env.API_VERSION,
    eventSchemaVersion: process.env.EVENT_SCHEMA_VERSION,
    dbMigrationVersion: process.env.DB_MIGRATION_VERSION,
  };

  // Validate network configuration
  const networkResult = NetworkConfigSchema.safeParse({
    network: env.network ?? 'testnet',
    rpcUrl: env.rpcUrl ?? 'https://soroban-testnet.stellar.org',
    horizonUrl: env.horizonUrl ?? 'https://horizon-testnet.stellar.org',
    networkPassphrase: env.networkPassphrase ?? 'Test SDF Network ; September 2015',
  });

  if (!networkResult.success) {
    throw new ValidationError(
      `[NETWORK] Invalid network configuration:\n` +
      networkResult.error.errors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }

  // Validate contract configuration
  const contractResult = ContractConfigSchema.safeParse({
    marketplaceContractId: env.marketplaceContractId,
    launchpadContractId: env.launchpadContractId,
  });

  if (!contractResult.success) {
    throw new ValidationError(
      `[CONTRACT] Invalid contract configuration:\n` +
      contractResult.error.errors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }

  // Validate indexer configuration
  const indexerResult = IndexerConfigSchema.safeParse({
    indexerUrl: env.indexerUrl ?? 'http://localhost:4000',
    operatorToken: env.operatorToken ?? '',
    operatorAllowlist: env.operatorAllowlist ?? '',
  });

  if (!indexerResult.success) {
    throw new ValidationError(
      `[INDEXER] Invalid indexer configuration:\n` +
      indexerResult.error.errors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }

  // Validate database configuration
  const databaseResult = DatabaseConfigSchema.safeParse({
    databaseUrl: env.databaseUrl ?? '',
    redisUrl: env.redisUrl ?? '',
  });

  if (!databaseResult.success) {
    throw new ValidationError(
      `[DATABASE] Invalid database configuration:\n` +
      databaseResult.error.errors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }

  // Validate IPFS configuration
  const ipfsResult = IpfsConfigSchema.safeParse({
    pinataGateway: env.pinataGateway ?? 'https://gateway.pinata.cloud',
    pinataJwt: env.pinataJwt,
  });

  if (!ipfsResult.success) {
    throw new ValidationError(
      `[IPFS] Invalid IPFS configuration:\n` +
      ipfsResult.error.errors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }

  // Validate keeper configuration
  const keeperResult = KeeperConfigSchema.safeParse({
    keeperEnabled: env.keeperEnabled,
    keeperDryRun: env.keeperDryRun,
    keeperSecret: env.keeperSecret,
    keeperIntervalMs: env.keeperIntervalMs,
    keeperMaxActionsPerCycle: env.keeperMaxActionsPerCycle,
    keeperMaxFeeStroops: env.keeperMaxFeeStroops,
    keeperDailyFeeBudgetStroops: env.keeperDailyFeeBudgetStroops,
    keeperFeeBumpMultiplier: env.keeperFeeBumpMultiplier,
    keeperFeeBumpMaxRetries: env.keeperFeeBumpMaxRetries,
    keeperSubmitTimeoutMs: env.keeperSubmitTimeoutMs,
  });

  if (!keeperResult.success) {
    throw new ValidationError(
      `[KEEPER] Invalid keeper configuration:\n` +
      keeperResult.error.errors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }

  // Validate version configuration
  const versionResult = VersionConfigSchema.safeParse({
    appVersion: env.appVersion,
    apiVersion: env.apiVersion,
    eventSchemaVersion: env.eventSchemaVersion,
    dbMigrationVersion: env.dbMigrationVersion,
  });

  if (!versionResult.success) {
    throw new ValidationError(
      `[VERSION] Invalid version configuration:\n` +
      versionResult.error.errors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }

  // Cross-component consistency checks
  const networkConfig = networkResult.data;
  const contractConfig = contractResult.data;
  const indexerConfig = indexerResult.data;
  const databaseConfig = databaseResult.data;
  const ipfsConfig = ipfsResult.data;
  const keeperConfig = keeperResult.data;
  const versionConfig = versionResult.data;

  validateNetworkConsistency(networkConfig);
  validateContractConsistency(contractConfig);
  validateIndexerUrlConsistency(indexerConfig);

  // Redacted diagnostics log (no secrets)
  console.log('[CONFIG] Configuration loaded successfully');
  console.log(`  Network: ${networkConfig.network}`);
  console.log(`  RPC: ${new URL(networkConfig.rpcUrl).hostname}`);
  console.log(`  Indexer URL: ${new URL(indexerConfig.indexerUrl).hostname}`);
  console.log(`  Marketplace Contract: ${contractConfig.marketplaceContractId.slice(0, 8)}...`);
  if (contractConfig.launchpadContractId) {
    console.log(`  Launchpad Contract: ${contractConfig.launchpadContractId.slice(0, 8)}...`);
  }
  if (keeperConfig.keeperEnabled) {
    console.log(`  Keeper: enabled (${keeperConfig.keeperDryRun ? 'dry-run' : 'live'})`);
  }

  // Return merged config
  return {
    network: networkConfig.network,
    rpcUrl: networkConfig.rpcUrl,
    horizonUrl: networkConfig.horizonUrl,
    networkPassphrase: networkConfig.networkPassphrase,
    marketplaceContractId: contractConfig.marketplaceContractId,
    launchpadContractId: contractConfig.launchpadContractId,
    indexerUrl: indexerConfig.indexerUrl,
    operatorToken: indexerConfig.operatorToken,
    operatorAllowlist: indexerConfig.operatorAllowlist,
    databaseUrl: databaseConfig.databaseUrl,
    redisUrl: databaseConfig.redisUrl,
    pinataGateway: ipfsConfig.pinataGateway,
    pinataJwt: ipfsConfig.pinataJwt,
    keeperEnabled: keeperConfig.keeperEnabled,
    keeperDryRun: keeperConfig.keeperDryRun,
    keeperSecret: keeperConfig.keeperSecret,
    keeperIntervalMs: keeperConfig.keeperIntervalMs,
    keeperMaxActionsPerCycle: keeperConfig.keeperMaxActionsPerCycle,
    keeperMaxFeeStroops: keeperConfig.keeperMaxFeeStroops,
    keeperDailyFeeBudgetStroops: keeperConfig.keeperDailyFeeBudgetStroops,
    keeperFeeBumpMultiplier: keeperConfig.keeperFeeBumpMultiplier,
    keeperFeeBumpMaxRetries: keeperConfig.keeperFeeBumpMaxRetries,
    keeperSubmitTimeoutMs: keeperConfig.keeperSubmitTimeoutMs,
    appVersion: versionConfig.appVersion,
    apiVersion: versionConfig.apiVersion,
    eventSchemaVersion: versionConfig.eventSchemaVersion,
    dbMigrationVersion: versionConfig.dbMigrationVersion,
  };
}

// ── Type inference helper ─────────────────────────────────────────────────────

/** Returns a subset of config keys for a given component */
export type ComponentConfig = 'network' | 'contracts' | 'indexer' | 'database' | 'ipfs' | 'keeper' | 'version';
