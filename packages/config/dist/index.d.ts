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
export declare class ValidationError extends Error {
    constructor(message: string);
}
export declare class MissingEnvError extends Error {
    missing: string[];
    constructor(message: string, missing: string[]);
}
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
export declare function loadConfig(): Config;
/** Returns a subset of config keys for a given component */
export type ComponentConfig = 'network' | 'contracts' | 'indexer' | 'database' | 'ipfs' | 'keeper' | 'version';
//# sourceMappingURL=index.d.ts.map