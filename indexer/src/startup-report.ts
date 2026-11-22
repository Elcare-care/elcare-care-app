/**
 * startup-report.ts — Non-secret startup configuration report (Issue #1067).
 *
 * Builds a structured summary of the settings the indexer booted with so an
 * operator can confirm, from the first log lines alone, which network,
 * contracts, RPC endpoint, database/Redis targets, and poll settings are in
 * effect — and spot testnet/mainnet mix-ups before any ledger is ingested.
 *
 * Safety rules (enforced here and asserted in startup-report.test.ts):
 *   - URLs are reduced to scheme + host + port. Userinfo (user:password@),
 *     path, query string and fragment are ALWAYS dropped — RPC providers
 *     commonly embed API keys in the path or query.
 *   - DATABASE_URL reports host, port and database name only.
 *   - REDIS_URL reports host, port and logical DB index only.
 *   - Secret-bearing variables (OPERATOR_TOKEN, KEEPER_SECRET, PINATA_JWT,
 *     SENTRY_DSN, …) are reported by NAME only (set / unset).
 *   - Contract IDs are public on-chain addresses and are reported in full.
 *
 * The report never throws: a value that cannot be parsed is reported as
 * invalid with a warning, so the report itself cannot block startup. Fatal
 * validation remains the job of validateRequiredEnv() / loadConfig().
 *
 * See docs/runbooks/startup-config-report.md.
 */

import { loadConfig, parseTrackedContracts, type TrackedContractConfig } from './config.js';
import { logger } from './logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SafeEndpoint {
  /** e.g. "https:" — null when the value could not be parsed */
  scheme: string | null;
  host: string | null;
  port: string | null;
  /** True when the raw value was present but not a parseable URL */
  invalid: boolean;
}

export interface StartupWarning {
  code:
    | 'NETWORK_UNKNOWN'
    | 'PASSPHRASE_NETWORK_MISMATCH'
    | 'RPC_NETWORK_MISMATCH'
    | 'HORIZON_NETWORK_MISMATCH'
    | 'CONTRACT_LABEL_NETWORK_MISMATCH'
    | 'CONTRACT_ID_FORMAT'
    | 'NO_TRACKED_CONTRACTS'
    | 'TRACKED_CONTRACTS_INVALID'
    | 'MAINNET_LOCAL_DEPENDENCY'
    | 'MAINNET_INSECURE_RPC'
    | 'INVALID_URL'
    | 'POLL_SETTINGS_INVALID';
  /** Setting name(s) involved — never the value of a secret */
  setting: string;
  message: string;
}

export interface StartupConfigReport {
  network: string | null;
  /** Which well-known passphrase is configured — the label, not a secret */
  networkPassphrase: 'testnet' | 'mainnet' | 'default' | 'unrecognized';
  rpc: SafeEndpoint | null;
  archivalRpc: SafeEndpoint | null;
  horizon: SafeEndpoint | null;
  database: (SafeEndpoint & { name: string | null }) | null;
  redis: (SafeEndpoint & { db: string | null }) | null;
  contracts: Array<Pick<TrackedContractConfig, 'id' | 'type' | 'label' | 'startLedger'>>;
  contractSource: 'TRACKED_CONTRACTS' | 'MARKETPLACE_CONTRACT_ID/LAUNCHPAD_CONTRACT_ID' | 'none';
  poll: {
    pollIntervalMs: number;
    maxLedgersPerCycle: number;
    confirmationDepth: number;
  } | null;
  /**
   * Names of secret-bearing settings that are set / unset. Values are never
   * read out. (Arrays of names rather than a name-keyed object, because the
   * log sanitizer redacts any field whose KEY contains "token"/"secret".)
   */
  credentialsSet: string[];
  credentialsUnset: string[];
  warnings: StartupWarning[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/** Settings whose VALUES must never be logged — reported by name only. */
export const SECRET_SETTING_NAMES = [
  'OPERATOR_TOKEN',
  'OPERATOR_API_KEY',
  'HEALTH_DETAILS_TOKEN',
  'CURSOR_SECRET',
  'KEEPER_SECRET',
  'PINATA_JWT',
  'SENTRY_DSN',
] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const TESTNET_HINT = /(^|[.-])(testnet|futurenet)([.-]|$)/i;
const MAINNET_HINT = /(^|[.-])(mainnet|pubnet)([.-]|$)/i;
const MAINNET_HORIZON_HOST = 'horizon.stellar.org';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Reduces a URL to scheme/host/port. Never returns userinfo, path, query or
 * fragment. Returns null when the value is absent.
 */
export function toSafeEndpoint(raw: string | undefined): SafeEndpoint | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const u = new URL(raw.trim());
    return { scheme: u.protocol, host: u.hostname || null, port: u.port || null, invalid: false };
  } catch {
    return { scheme: null, host: null, port: null, invalid: true };
  }
}

function firstPathSegment(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const seg = new URL(raw.trim()).pathname.replace(/^\/+/, '').split('/')[0];
    return seg ? decodeURIComponent(seg) : null;
  } catch {
    return null;
  }
}

function classifyPassphrase(raw: string | undefined): StartupConfigReport['networkPassphrase'] {
  if (raw === undefined || raw === '') return 'default';
  if (raw === TESTNET_PASSPHRASE) return 'testnet';
  if (raw === MAINNET_PASSPHRASE) return 'mainnet';
  return 'unrecognized';
}

function isLocal(ep: SafeEndpoint | null): boolean {
  return !!ep?.host && LOCAL_HOSTS.has(ep.host);
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Builds the startup report from an environment object (defaults to
 * process.env). Pure apart from reading `env`; never throws.
 */
export function buildStartupConfigReport(env: NodeJS.ProcessEnv = process.env): StartupConfigReport {
  const warnings: StartupWarning[] = [];
  const network = env.STELLAR_NETWORK?.trim() || null;

  // ── Network & passphrase ───────────────────────────────────────────────────
  const networkPassphrase = classifyPassphrase(env.STELLAR_NETWORK_PASSPHRASE);
  if (network !== null && network !== 'testnet' && network !== 'mainnet') {
    warnings.push({
      code: 'NETWORK_UNKNOWN',
      setting: 'STELLAR_NETWORK',
      message: `STELLAR_NETWORK="${network}" is not "testnet" or "mainnet".`,
    });
  }
  if (
    (network === 'mainnet' && networkPassphrase === 'testnet') ||
    (network === 'testnet' && networkPassphrase === 'mainnet') ||
    (network === 'mainnet' && networkPassphrase === 'default')
  ) {
    warnings.push({
      code: 'PASSPHRASE_NETWORK_MISMATCH',
      setting: 'STELLAR_NETWORK, STELLAR_NETWORK_PASSPHRASE',
      message:
        networkPassphrase === 'default'
          ? 'STELLAR_NETWORK=mainnet but STELLAR_NETWORK_PASSPHRASE is unset (validator default is the testnet passphrase).'
          : `STELLAR_NETWORK=${network} but STELLAR_NETWORK_PASSPHRASE is the ${networkPassphrase} passphrase.`,
    });
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────
  const rpc = toSafeEndpoint(env.STELLAR_RPC_URL);
  const archivalRpc = toSafeEndpoint(env.ARCHIVAL_STELLAR_RPC_URL);
  const horizon = toSafeEndpoint(env.STELLAR_HORIZON_URL);
  const dbEp = toSafeEndpoint(env.DATABASE_URL);
  const redisEp = toSafeEndpoint(env.REDIS_URL);

  const endpoints: Array<[string, SafeEndpoint | null]> = [
    ['STELLAR_RPC_URL', rpc],
    ['ARCHIVAL_STELLAR_RPC_URL', archivalRpc],
    ['STELLAR_HORIZON_URL', horizon],
    ['DATABASE_URL', dbEp],
    ['REDIS_URL', redisEp],
  ];
  for (const [name, ep] of endpoints) {
    if (ep?.invalid) {
      warnings.push({ code: 'INVALID_URL', setting: name, message: `${name} is set but is not a parseable URL.` });
    }
  }

  for (const [name, ep] of [['STELLAR_RPC_URL', rpc], ['ARCHIVAL_STELLAR_RPC_URL', archivalRpc]] as const) {
    if (!ep?.host) continue;
    if (network === 'mainnet' && TESTNET_HINT.test(ep.host)) {
      warnings.push({
        code: 'RPC_NETWORK_MISMATCH',
        setting: `STELLAR_NETWORK, ${name}`,
        message: `STELLAR_NETWORK=mainnet but ${name} host "${ep.host}" looks like a testnet/futurenet endpoint.`,
      });
    } else if (network === 'testnet' && MAINNET_HINT.test(ep.host)) {
      warnings.push({
        code: 'RPC_NETWORK_MISMATCH',
        setting: `STELLAR_NETWORK, ${name}`,
        message: `STELLAR_NETWORK=testnet but ${name} host "${ep.host}" looks like a mainnet endpoint.`,
      });
    }
  }

  if (horizon?.host) {
    if (
      (network === 'mainnet' && TESTNET_HINT.test(horizon.host)) ||
      (network === 'testnet' && horizon.host === MAINNET_HORIZON_HOST)
    ) {
      warnings.push({
        code: 'HORIZON_NETWORK_MISMATCH',
        setting: 'STELLAR_NETWORK, STELLAR_HORIZON_URL',
        message: `STELLAR_NETWORK=${network} but STELLAR_HORIZON_URL host "${horizon.host}" belongs to the other network.`,
      });
    }
  }

  if (network === 'mainnet') {
    for (const [name, ep] of endpoints) {
      if (isLocal(ep)) {
        warnings.push({
          code: 'MAINNET_LOCAL_DEPENDENCY',
          setting: name,
          message: `STELLAR_NETWORK=mainnet but ${name} points at a local host.`,
        });
      }
    }
    if (rpc?.scheme === 'http:' && !isLocal(rpc)) {
      warnings.push({
        code: 'MAINNET_INSECURE_RPC',
        setting: 'STELLAR_RPC_URL',
        message: 'STELLAR_RPC_URL uses plain http on mainnet.',
      });
    }
  }

  // ── Contracts ──────────────────────────────────────────────────────────────
  let contracts: StartupConfigReport['contracts'] = [];
  const contractSource: StartupConfigReport['contractSource'] =
    env.TRACKED_CONTRACTS && env.TRACKED_CONTRACTS.trim() !== ''
      ? 'TRACKED_CONTRACTS'
      : env.MARKETPLACE_CONTRACT_ID || env.LAUNCHPAD_CONTRACT_ID
        ? 'MARKETPLACE_CONTRACT_ID/LAUNCHPAD_CONTRACT_ID'
        : 'none';
  try {
    contracts = parseTrackedContracts(env).map(({ id, type, label, startLedger }) => ({ id, type, label, startLedger }));
  } catch (err) {
    warnings.push({
      code: 'TRACKED_CONTRACTS_INVALID',
      setting: 'TRACKED_CONTRACTS',
      // parseTrackedContracts messages name fields/paths only, never values.
      message: err instanceof Error ? err.message : 'TRACKED_CONTRACTS could not be parsed.',
    });
  }
  if (contracts.length === 0 && contractSource !== 'TRACKED_CONTRACTS') {
    warnings.push({
      code: 'NO_TRACKED_CONTRACTS',
      setting: 'TRACKED_CONTRACTS, MARKETPLACE_CONTRACT_ID',
      message: 'No contracts are configured; the poller will have nothing to index.',
    });
  }
  for (const c of contracts) {
    if (c.id.length !== 56 || !c.id.startsWith('C')) {
      warnings.push({
        code: 'CONTRACT_ID_FORMAT',
        setting: `contract "${c.label || c.type}"`,
        message: `Contract id "${c.id}" is not a 56-character Soroban address starting with "C".`,
      });
    }
    if (
      (network === 'mainnet' && TESTNET_HINT.test(c.label)) ||
      (network === 'testnet' && MAINNET_HINT.test(c.label))
    ) {
      warnings.push({
        code: 'CONTRACT_LABEL_NETWORK_MISMATCH',
        setting: 'TRACKED_CONTRACTS',
        message: `STELLAR_NETWORK=${network} but contract label "${c.label}" names the other network.`,
      });
    }
  }

  // ── Poll settings ──────────────────────────────────────────────────────────
  let poll: StartupConfigReport['poll'] = null;
  try {
    const cfg = loadConfig(env);
    poll = {
      pollIntervalMs: cfg.pollIntervalMs,
      maxLedgersPerCycle: cfg.maxLedgersPerCycle,
      confirmationDepth: cfg.confirmationDepth,
    };
  } catch (err) {
    warnings.push({
      code: 'POLL_SETTINGS_INVALID',
      setting: 'POLL_INTERVAL_MS, MAX_LEDGERS_PER_CYCLE, CONFIRMATION_DEPTH',
      message: err instanceof Error ? err.message : 'Poll settings could not be parsed.',
    });
  }

  // ── Credentials (presence only) ────────────────────────────────────────────
  const credentialsSet: string[] = [];
  const credentialsUnset: string[] = [];
  for (const name of SECRET_SETTING_NAMES) {
    (typeof env[name] === 'string' && env[name]!.length > 0 ? credentialsSet : credentialsUnset).push(name);
  }

  return {
    network,
    networkPassphrase,
    rpc,
    archivalRpc,
    horizon,
    database: dbEp ? { ...dbEp, name: firstPathSegment(env.DATABASE_URL) } : null,
    redis: redisEp ? { ...redisEp, db: firstPathSegment(env.REDIS_URL) } : null,
    contracts,
    contractSource,
    poll,
    credentialsSet,
    credentialsUnset,
    warnings,
  };
}

/**
 * Logs the report: one INFO line with the full report, plus one WARN line per
 * warning so log-based alerts can match on `code`.
 */
export function logStartupConfigReport(report: StartupConfigReport): void {
  logger.info('[startup] configuration report', { startupConfig: report });
  for (const w of report.warnings) {
    logger.warn(`[startup] configuration warning: ${w.code}`, { code: w.code, setting: w.setting, detail: w.message });
  }
}
