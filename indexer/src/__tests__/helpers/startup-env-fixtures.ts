/**
 * Startup environment fixtures — Issue #1067.
 *
 * Complete env objects for a healthy testnet and mainnet boot, plus named
 * misconfiguration variants. Every value is a FAKE placeholder:
 *   - contract ids are syntactically valid (56 chars, "C…") but not deployed,
 *   - "credentials" embedded in URLs / tokens are sentinel strings that tests
 *     assert NEVER appear in the startup report or its log output.
 *
 * Do not replace these with real endpoints, keys or contract ids.
 */

/** Sentinel substrings that must never leak into report/log output. */
export const LEAK_SENTINELS = [
  'fixture-db-password',
  'fixture-redis-password',
  'fixture-rpc-path-key',
  'fixture-rpc-query-key',
  'fixture-operator-token',
  'fixture_db_user',
] as const;

const FAKE_MARKETPLACE_ID = 'C' + 'A'.repeat(55);
const FAKE_LAUNCHPAD_ID = 'C' + 'B'.repeat(55);

/** Shared non-network settings, including secrets the report must hide. */
const COMMON: Record<string, string> = {
  MARKETPLACE_CONTRACT_ID: FAKE_MARKETPLACE_ID,
  LAUNCHPAD_CONTRACT_ID: FAKE_LAUNCHPAD_ID,
  OPERATOR_TOKEN: 'fixture-operator-token-0000000000000000',
  POLL_INTERVAL_MS: '5000',
  MAX_LEDGERS_PER_CYCLE: '1000',
  CONFIRMATION_DEPTH: '10',
};

export const VALID_TESTNET_ENV: Record<string, string> = {
  ...COMMON,
  STELLAR_NETWORK: 'testnet',
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  DATABASE_URL: 'postgresql://fixture_db_user:fixture-db-password@localhost:5432/marketplace',
  REDIS_URL: 'redis://:fixture-redis-password@localhost:6379/0',
};

export const VALID_MAINNET_ENV: Record<string, string> = {
  ...COMMON,
  STELLAR_NETWORK: 'mainnet',
  STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
  // Provider-style URL with an API key in the path AND query — both must be dropped.
  STELLAR_RPC_URL: 'https://rpc.mainnet.example.net/fixture-rpc-path-key?apikey=fixture-rpc-query-key',
  STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
  DATABASE_URL: 'postgresql://fixture_db_user:fixture-db-password@db.internal.example:5432/marketplace_prod',
  REDIS_URL: 'redis://:fixture-redis-password@cache.internal.example:6380/2',
  POLL_INTERVAL_MS: '3000',
};

/**
 * Misconfiguration fixtures. `expectWarning` is the StartupWarning.code the
 * report must emit; `fatal` marks cases that validateRequiredEnv() must also
 * reject (via the shared @elcarehub/config passphrase check).
 */
export const MISCONFIGURED_ENVS: Array<{
  name: string;
  env: Record<string, string>;
  expectWarning: string;
  fatal?: RegExp;
}> = [
  // ── Mainnet misconfigurations ───────────────────────────────────────────────
  {
    name: 'mainnet with testnet passphrase',
    env: { ...VALID_MAINNET_ENV, STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015' },
    expectWarning: 'PASSPHRASE_NETWORK_MISMATCH',
    fatal: /passphrase mismatch/i,
  },
  {
    name: 'mainnet with passphrase unset (validator defaults to testnet)',
    env: (() => {
      const { STELLAR_NETWORK_PASSPHRASE: _omit, ...rest } = VALID_MAINNET_ENV;
      return rest;
    })(),
    expectWarning: 'PASSPHRASE_NETWORK_MISMATCH',
    fatal: /passphrase mismatch/i,
  },
  {
    name: 'mainnet pointed at the testnet RPC',
    env: { ...VALID_MAINNET_ENV, STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org' },
    expectWarning: 'RPC_NETWORK_MISMATCH',
  },
  {
    name: 'mainnet pointed at the testnet Horizon',
    env: { ...VALID_MAINNET_ENV, STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org' },
    expectWarning: 'HORIZON_NETWORK_MISMATCH',
  },
  {
    name: 'mainnet using a local database',
    env: { ...VALID_MAINNET_ENV, DATABASE_URL: 'postgresql://fixture_db_user:fixture-db-password@localhost:5432/marketplace' },
    expectWarning: 'MAINNET_LOCAL_DEPENDENCY',
  },
  {
    name: 'mainnet RPC over plain http',
    env: { ...VALID_MAINNET_ENV, STELLAR_RPC_URL: 'http://rpc.mainnet.example.net' },
    expectWarning: 'MAINNET_INSECURE_RPC',
  },
  {
    name: 'mainnet tracking a contract labelled testnet',
    env: {
      ...VALID_MAINNET_ENV,
      TRACKED_CONTRACTS: JSON.stringify([{ id: FAKE_MARKETPLACE_ID, type: 'marketplace', label: 'testnet', startLedger: 0 }]),
    },
    expectWarning: 'CONTRACT_LABEL_NETWORK_MISMATCH',
  },
  // ── Testnet misconfigurations ───────────────────────────────────────────────
  {
    name: 'testnet with mainnet passphrase',
    env: { ...VALID_TESTNET_ENV, STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015' },
    expectWarning: 'PASSPHRASE_NETWORK_MISMATCH',
    fatal: /passphrase mismatch/i,
  },
  {
    name: 'testnet pointed at a mainnet RPC',
    env: { ...VALID_TESTNET_ENV, STELLAR_RPC_URL: 'https://rpc.mainnet.example.net' },
    expectWarning: 'RPC_NETWORK_MISMATCH',
  },
  {
    name: 'testnet pointed at the mainnet Horizon',
    env: { ...VALID_TESTNET_ENV, STELLAR_HORIZON_URL: 'https://horizon.stellar.org' },
    expectWarning: 'HORIZON_NETWORK_MISMATCH',
  },
  {
    name: 'testnet tracking a contract labelled mainnet',
    env: {
      ...VALID_TESTNET_ENV,
      TRACKED_CONTRACTS: JSON.stringify([{ id: FAKE_MARKETPLACE_ID, type: 'marketplace', label: 'mainnet', startLedger: 0 }]),
    },
    expectWarning: 'CONTRACT_LABEL_NETWORK_MISMATCH',
  },
  // ── Network-independent misconfigurations ───────────────────────────────────
  {
    name: 'unknown network name',
    env: { ...VALID_TESTNET_ENV, STELLAR_NETWORK: 'futurenet' },
    expectWarning: 'NETWORK_UNKNOWN',
  },
  {
    name: 'truncated contract id',
    env: { ...VALID_TESTNET_ENV, MARKETPLACE_CONTRACT_ID: 'CSHORT' },
    expectWarning: 'CONTRACT_ID_FORMAT',
  },
  {
    name: 'TRACKED_CONTRACTS is not JSON',
    env: { ...VALID_TESTNET_ENV, TRACKED_CONTRACTS: '[{id: not-json' },
    expectWarning: 'TRACKED_CONTRACTS_INVALID',
  },
  {
    name: 'no contracts configured',
    env: (() => {
      const { MARKETPLACE_CONTRACT_ID: _m, LAUNCHPAD_CONTRACT_ID: _l, ...rest } = VALID_TESTNET_ENV;
      return rest;
    })(),
    expectWarning: 'NO_TRACKED_CONTRACTS',
  },
  {
    name: 'non-numeric POLL_INTERVAL_MS',
    env: { ...VALID_TESTNET_ENV, POLL_INTERVAL_MS: 'fast' },
    expectWarning: 'POLL_SETTINGS_INVALID',
  },
  {
    name: 'unparseable RPC URL',
    env: { ...VALID_TESTNET_ENV, STELLAR_RPC_URL: 'not a url' },
    expectWarning: 'INVALID_URL',
  },
];
