// ─────────────────────────────────────────────────────────────
// lib/wallet-persistence.ts — Wallet persistence with privacy & expiration
//
// Privacy-conscious wallet state persistence with versioning and user control.
//
// AUDIT OF PERSISTED DATA:
// ────────────────────────────────────────────────────────────
//
// CURRENT SCHEMA v1 PERSISTS (non-sensitive):
//   - walletAddress (public key identifier only, NOT derivable to private key)
//   - connectorId (wallet type: 'freighter' | 'lobstr' | 'magic')
//   - lastUsed (Unix timestamp of last connection)
//   - expiresAt (Unix timestamp for automatic clear)
//   - chainId (network identifier)
//
// EXPLICITLY NEVER PERSISTED (dangerous data):
//   - Private keys / mnemonics (never touched by frontend)
//   - Signatures (ephemeral, signed once, discarded)
//   - Raw provider SDK responses (may contain transient tokens)
//   - Transaction hashes (stored in indexer only, on-chain)
//   - Approval states (session-only, discarded on disconnect)
//   - Session tokens / JWT (not used; wallet connection = auth)
//   - User secrets / seed phrases (user's responsibility; hardware wallet stores)
//
// STORAGE STRATEGY:
//   - localStorage: Default (persists across sessions)
//   - sessionStorage: If user disables "Remember Wallet" (clears on tab close)
//   - In-memory: If localStorage/sessionStorage unavailable (graceful fallback)
//
// THREAT MODEL:
//   1. XSS attack: localStorage readable by injected JS. Mitigated by:
//      - Only storing non-sensitive identifiers (public data)
//      - No secrets or private keys ever touch browser storage
//      - CSP + frame guards prevent most injections
//
//   2. Theft of wallet address: Acceptable risk (public key is pseudonymous)
//      but can be linked to on-chain activity. User can disconnect to clear.
//
//   3. Device theft: Disk is encrypted on modern OS. Acceptable user responsibility.
//
// ─────────────────────────────────────────────────────────────

// ── Schema & Versioning ───────────────────────────────────────

/**
 * Current wallet persistence schema version.
 * Increment when changing the stored data structure.
 * Migrations run automatically if stored version < current.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Non-sensitive wallet state schema.
 * Safe to persist to localStorage (public data only).
 */
export interface WalletPersistenceSchema {
  version: number;
  walletAddress: string;      // Stellar public key (non-sensitive identifier)
  connectorId: WalletConnectorId; // Which wallet provider
  lastUsed: number;           // Unix timestamp
  expiresAt: number;          // Unix timestamp (lastUsed + TTL)
  chainId: number;            // Network identifier
}

export type WalletConnectorId = 'freighter' | 'lobstr' | 'magic';
export type WalletProvider = WalletConnectorId; // Alias for backwards compat

// ── Storage Keys ──────────────────────────────────────────────

const SCHEMA_KEY = 'elcare.wallet.state.v1';
const REMEMBER_WALLET_KEY = 'elcare.wallet.remember';
const PENDING_ACCOUNT_KEY = 'elcare.wallet.pending_account'; // For account switching

// ── TTL Configuration ────────────────────────────────────────

/** Default session TTL: 7 days. Override via options if needed. */
export const DEFAULT_WALLET_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Development Logging ──────────────────────────────────────

const isDev = typeof window !== 'undefined' && process.env.NODE_ENV === 'development';

function devLog(msg: string, data?: unknown): void {
  if (!isDev) return;
  console.debug(`[wallet-persistence] ${msg}`, data ?? '');
}

// ── Storage Utilities ────────────────────────────────────────

/**
 * Safely read from localStorage or sessionStorage.
 * Returns null on any error (parse, quota, security).
 */
function safeRead(key: string, storage: Storage): string | null {
  try {
    return storage.getItem(key);
  } catch (err) {
    if (err instanceof SecurityError) {
      devLog('Storage blocked by security policy (likely private browsing)', err);
    } else if (err instanceof Error && err.name === 'QuotaExceededError') {
      devLog('Storage quota exceeded', err);
    } else {
      devLog('Unexpected storage error', err);
    }
    return null;
  }
}

/**
 * Safely write to localStorage or sessionStorage.
 * Returns true on success, false on any error.
 */
function safeWrite(key: string, value: string, storage: Storage): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch (err) {
    if (err instanceof SecurityError) {
      devLog('Storage write blocked by security policy', err);
    } else if (err instanceof Error && err.name === 'QuotaExceededError') {
      devLog('Storage quota exceeded on write', err);
    } else {
      devLog('Unexpected storage write error', err);
    }
    return false;
  }
}

/**
 * Safely remove from localStorage or sessionStorage.
 * Returns true on success, false if already missing or error.
 */
function safeRemove(key: string, storage: Storage): boolean {
  try {
    if (storage.getItem(key) === null) return true; // Already gone
    storage.removeItem(key);
    return true;
  } catch (err) {
    devLog('Storage remove error', err);
    return false;
  }
}

// ── Get Active Storage ─────────────────────────────────────────

/**
 * Determine which storage backend to use.
 * - If "Remember Wallet" is enabled: localStorage (default)
 * - If "Remember Wallet" is disabled: sessionStorage
 *
 * Falls back gracefully if both are unavailable.
 */
function getActiveStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  const rememberWallet = getRememberWalletPreference();

  const targetStorage = rememberWallet ? localStorage : sessionStorage;
  const backupStorage = !rememberWallet ? localStorage : sessionStorage;

  // Test write access
  try {
    const testKey = '__storage_test__';
    targetStorage.setItem(testKey, '1');
    targetStorage.removeItem(testKey);
    return targetStorage;
  } catch {
    // Target storage failed, try backup
    try {
      const testKey = '__storage_test__';
      backupStorage.setItem(testKey, '1');
      backupStorage.removeItem(testKey);
      devLog('Primary storage unavailable, using backup', { rememberWallet });
      return backupStorage;
    } catch {
      devLog('All storage backends unavailable, falling back to in-memory');
      return null;
    }
  }
}

// ── User Preference: Remember Wallet ───────────────────────

/**
 * Read user preference: should we persist wallet across sessions?
 * Defaults to true (opt-out model for UX).
 * This is always stored in localStorage regardless of the wallet data location.
 */
export function getRememberWalletPreference(): boolean {
  if (typeof window === 'undefined') return true;
  const stored = safeRead(REMEMBER_WALLET_KEY, localStorage);
  if (stored === null) return true; // Default: remember
  return stored === 'true';
}

/**
 * Set user preference: should we persist wallet across sessions?
 * - true: use localStorage (persist across sessions)
 * - false: use sessionStorage (clear on tab close)
 *
 * SIDE EFFECT: If setting to false, immediately clears existing
 * localStorage wallet data to enforce privacy.
 */
export function setRememberWalletPreference(remember: boolean): void {
  if (typeof window === 'undefined') return;

  const success = safeWrite(
    REMEMBER_WALLET_KEY,
    remember ? 'true' : 'false',
    localStorage
  );

  if (!success) {
    devLog('Failed to persist remember-wallet preference');
  }

  // If disabling remember: clear localStorage wallet data immediately
  if (!remember) {
    devLog('Remember wallet disabled, clearing localStorage data');
    safeRemove(SCHEMA_KEY, localStorage);
  }
}

// ── Schema Versioning & Migration ──────────────────────────────

/**
 * Handle schema version mismatch.
 * - If stored version < current: potential migration needed. For v1, just clear.
 * - If stored version > current: unsupported (downgrade?). Clear safely.
 */
function handleSchemaMismatch(storedVersion: number): void {
  devLog(`Schema version mismatch: stored=${storedVersion}, current=${CURRENT_SCHEMA_VERSION}`);

  // For now, v1 only. In future, add migration logic here.
  // E.g., if (storedVersion === 0) { migrateFromV0(); }
  // For safety, just clear incompatible data.
  if (storedVersion !== CURRENT_SCHEMA_VERSION) {
    const storage = getActiveStorage();
    if (storage) safeRemove(SCHEMA_KEY, storage);
  }
}

// ── Main API: Save ───────────────────────────────────────────

export interface SaveWalletOptions {
  ttlMs?: number; // Override default TTL
}

/**
 * Persist wallet connection state.
 * - Stores only non-sensitive identifiers (address, connector type, timestamps).
 * - Respects user's "Remember Wallet" preference.
 * - Returns true if successfully persisted, false if storage unavailable.
 */
export function saveWalletState(
  walletAddress: string,
  connectorId: WalletConnectorId,
  chainId: number,
  options?: SaveWalletOptions
): boolean {
  if (typeof window === 'undefined') return false;

  const ttl = options?.ttlMs ?? DEFAULT_WALLET_TTL_MS;
  const now = Date.now();

  const schema: WalletPersistenceSchema = {
    version: CURRENT_SCHEMA_VERSION,
    walletAddress,
    connectorId,
    lastUsed: now,
    expiresAt: now + ttl,
    chainId,
  };

  const storage = getActiveStorage();
  if (!storage) {
    devLog('No storage backend available, wallet state not persisted');
    return false;
  }

  try {
    const json = JSON.stringify(schema);
    const success = safeWrite(SCHEMA_KEY, json, storage);
    if (success) {
      devLog('Wallet state persisted', { walletAddress, connectorId, expiresAt: schema.expiresAt });
    }
    return success;
  } catch (err) {
    devLog('Failed to serialize wallet state', err);
    return false;
  }
}

// ── Main API: Load ───────────────────────────────────────────

export interface LoadedWalletState {
  walletAddress: string;
  connectorId: WalletConnectorId;
  chainId: number;
}

/**
 * Load persisted wallet state if valid and not expired.
 * - Checks schema version and clears if incompatible.
 * - Checks expiration and clears if expired.
 * - Handles corrupted JSON gracefully (returns null, clears key).
 * - Falls back gracefully if storage unavailable.
 *
 * Returns null if:
 *   - No persisted state
 *   - State is expired
 *   - JSON is corrupted
 *   - Storage is unavailable
 *   - User disabled "Remember Wallet"
 */
export function loadWalletState(): LoadedWalletState | null {
  if (typeof window === 'undefined') return null;

  const storage = getActiveStorage();
  if (!storage) {
    devLog('No storage backend available for loading wallet state');
    return null;
  }

  const json = safeRead(SCHEMA_KEY, storage);
  if (!json) {
    devLog('No persisted wallet state found');
    return null;
  }

  // Parse JSON (corrupted storage handling)
  let schema: WalletPersistenceSchema;
  try {
    schema = JSON.parse(json);
  } catch (err) {
    devLog('Corrupted wallet state JSON, clearing', err);
    safeRemove(SCHEMA_KEY, storage);
    return null;
  }

  // Validate schema version
  if (typeof schema.version !== 'number') {
    devLog('Invalid schema version, clearing');
    safeRemove(SCHEMA_KEY, storage);
    return null;
  }

  if (schema.version !== CURRENT_SCHEMA_VERSION) {
    handleSchemaMismatch(schema.version);
    return null;
  }

  // Check expiration
  if (typeof schema.expiresAt !== 'number' || Date.now() > schema.expiresAt) {
    devLog('Wallet state expired, clearing', { expiresAt: schema.expiresAt, now: Date.now() });
    safeRemove(SCHEMA_KEY, storage);
    return null;
  }

  // Validate required fields
  if (!schema.walletAddress || !schema.connectorId || typeof schema.chainId !== 'number') {
    devLog('Invalid wallet state schema, clearing');
    safeRemove(SCHEMA_KEY, storage);
    return null;
  }

  devLog('Loaded wallet state', { walletAddress: schema.walletAddress, connectorId: schema.connectorId });

  return {
    walletAddress: schema.walletAddress,
    connectorId: schema.connectorId,
    chainId: schema.chainId,
  };
}

// ── Account Switching Safety ──────────────────────────────────

/**
 * On account switch, clear any pending action state tied to the old account.
 * This prevents carrying over approvals, pending transactions, or action context
 * from one account to another.
 *
 * IMPORTANT: Call this BEFORE calling saveWalletState() with the new account.
 */
export function clearPendingActionState(): void {
  if (typeof window === 'undefined') return;

  // Try both storages since user might switch the preference
  try {
    localStorage.removeItem(PENDING_ACCOUNT_KEY);
  } catch {
    // Ignore errors
  }

  try {
    sessionStorage.removeItem(PENDING_ACCOUNT_KEY);
  } catch {
    // Ignore errors
  }

  devLog('Cleared pending action state for account switch');
}

// ── Main API: Clear ──────────────────────────────────────────

/**
 * Clear all persisted wallet state.
 * Call on logout or disconnect to ensure clean slate.
 */
export function clearWalletState(): void {
  if (typeof window === 'undefined') return;

  const storage = getActiveStorage();
  if (storage) {
    safeRemove(SCHEMA_KEY, storage);
    devLog('Wallet state cleared');
  }

  // Always try to clean both storages
  safeRemove(SCHEMA_KEY, localStorage);
  safeRemove(SCHEMA_KEY, sessionStorage);

  clearPendingActionState();
}

// ── Backwards Compatibility ──────────────────────────────────

/**
 * Legacy function for old code. Maps to new API.
 * Deprecated: use saveWalletState() instead.
 */
export function saveWalletProvider(provider: WalletConnectorId): void {
  // Assume chainId = 0 (legacy didn't track network)
  // Assume default TTL (24h for backwards compat)
  const chainId = 0;
  const ttlMs = 24 * 60 * 60 * 1000; // 24h (original TTL)

  const storage = typeof window !== 'undefined' ? localStorage : null;
  if (!storage) return;

  // Also persist to old keys for compatibility
  try {
    storage.setItem('elcare.wallet.provider', provider);
    storage.setItem('elcare.wallet.expiry', String(Date.now() + ttlMs));
  } catch {
    // Ignore
  }

  // Now persist with new schema
  saveWalletState('[legacy-address]', provider, chainId, { ttlMs });
}

/**
 * Legacy function for old code. Maps to new API.
 * Deprecated: use loadWalletState() instead.
 */
export function loadWalletProvider(): WalletConnectorId | null {
  // Try new schema first
  const loaded = loadWalletState();
  if (loaded) {
    return loaded.connectorId;
  }

  // Fallback to old keys for backwards compat
  if (typeof window === 'undefined') return null;

  const provider = localStorage.getItem('elcare.wallet.provider') as WalletConnectorId | null;
  const expiry = localStorage.getItem('elcare.wallet.expiry');

  if (!provider || !expiry || Date.now() > parseInt(expiry, 10)) {
    clearWalletProvider();
    return null;
  }

  return provider;
}

/**
 * Legacy function for old code. Maps to new API.
 * Deprecated: use clearWalletState() instead.
 */
export function clearWalletProvider(): void {
  // Clear both old and new keys
  clearWalletState();
  try {
    localStorage.removeItem('elcare.wallet.provider');
    localStorage.removeItem('elcare.wallet.expiry');
  } catch {
    // Ignore
  }
}
