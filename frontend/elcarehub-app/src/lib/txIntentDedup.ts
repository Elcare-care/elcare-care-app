// ─────────────────────────────────────────────────────────────────────────────
// lib/txIntentDedup.ts — Client-side transaction intent deduplication (Issue #524)
//
// Double-clicks, mobile retries, and component remounts can submit the same
// listing, offer, or bid more than once. The contract may reject some of
// those duplicates, but the user still pays avoidable fees (failed-tx fees,
// wasted RPC round trips) and sees confusing errors.
//
// This module builds a deterministic "intent fingerprint" from the action
// type, the signing account, the network, the target contract, and the
// action's distinguishing arguments (price, token id, amount, listing id,
// ...). While an intent with that fingerprint is in flight — tracked in a
// small registry, scoped per account + network so switching accounts or
// networks never inherits stale entries — a second identical submission is
// short-circuited instead of resubmitted.
//
// STORAGE CHOICE: the registry is backed by localStorage rather than
// sessionStorage. sessionStorage is scoped per browsing-context (tab) and
// never shared between tabs, which would defeat the two-tab dedup
// requirement — the `storage` event (and reads of the value itself) only
// ever fire for localStorage. This mirrors the "session-safe storage where
// appropriate" guidance: nothing sensitive is stored here, only the same
// class of non-secret data useTxLifecycle already persists to sessionStorage
// for reload recovery (a fingerprint, an action label, a status, a tx hash,
// and timestamps). Every entry carries a short TTL (`windowMs`, default 20s)
// and is pruned aggressively on every read, so it never outlives the
// "avoid an accidental double submission" purpose it exists for. A terminal
// status (success/error) clears its entry immediately so an intentional
// retry after a failure is never blocked.
//
// CROSS-TAB SYNC: writes are announced via BroadcastChannel (when available)
// and are additionally observable via the native `storage` event that
// localStorage fires in *other* tabs automatically. Consumers subscribe with
// `subscribeToIntentChanges` to react to either signal.
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────────────

export type TxIntentStatus = "pending" | "success" | "error";

/** Inputs that determine whether two attempts are "the same" intent. */
export interface TxIntentInput {
  /** Action label, e.g. "Bid", "Create listing", "Accept offer". */
  action: string;
  /** Signing account (public key). */
  account: string;
  /** Network identifier that scopes the registry (e.g. network passphrase). */
  network: string;
  /** Target contract id, when the action invokes one specific contract. */
  contract?: string | null;
  /** Distinguishing arguments — price, token id, amount, listing id, etc. */
  args?: unknown;
}

export interface TxIntentRecord {
  fingerprint: string;
  action: string;
  status: TxIntentStatus;
  txHash: string | null;
  createdAt: number;
  updatedAt: number;
  /** End of the intent's short-lived validity window. */
  expiresAt: number;
}

export interface BeginIntentParams extends TxIntentInput {
  /** Validity window in ms. Defaults to DEFAULT_INTENT_WINDOW_MS. */
  windowMs?: number;
}

export interface BeginIntentResult {
  /** True when an identical, still-pending intent was already registered. */
  duplicate: boolean;
  fingerprint: string;
  record: TxIntentRecord;
}

export interface UpdateIntentParams {
  network: string;
  account: string;
  fingerprint: string;
  status: TxIntentStatus;
  txHash?: string | null;
}

export type IntentChangeListener = (scopeKey: string) => void;

// ── Config ───────────────────────────────────────────────────────────────────

/** Default short-lived validity window: 20 seconds. */
export const DEFAULT_INTENT_WINDOW_MS = 20_000;

const REGISTRY_PREFIX = "elcare.txIntent.v1";
const BROADCAST_CHANNEL_NAME = "elcare-tx-intent";

// ── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Recursively stringifies a value with object keys sorted, so semantically
 * identical argument objects always produce the same string regardless of
 * key insertion order (e.g. `{price, tokenId}` vs `{tokenId, price}`).
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? String(value) : "null";
  if (t === "boolean") return String(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  // functions, symbols, bigint, etc. — fall back to a stable-ish string form
  return JSON.stringify(String(value));
}

/** 32-bit FNV-1a hash. Not cryptographic — this is a dedup key, not a secret. */
function fnv1a(str: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Computes a deterministic fingerprint from the action, account, network,
 * contract, and arguments. Two calls with the same shape (even if argument
 * keys are ordered differently) produce the same fingerprint; changing any
 * one of price/account/contract/asset/etc. produces a different one.
 */
export function computeIntentFingerprint(input: TxIntentInput): string {
  const canonical = stableStringify({
    action: input.action,
    account: input.account,
    network: input.network,
    contract: input.contract ?? null,
    args: input.args ?? null,
  });
  const h1 = fnv1a(canonical, 0x811c9dc5);
  const h2 = fnv1a(canonical, 0x9e3779b9);
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

// ── Storage plumbing ─────────────────────────────────────────────────────────

function scopeKey(network: string, account: string): string {
  return `${REGISTRY_PREFIX}:${network || "unknown"}:${account || "unknown"}`;
}

/** True when a scope key belongs to this registry (used to filter storage events). */
function isRegistryKey(key: string | null): key is string {
  return !!key && key.startsWith(`${REGISTRY_PREFIX}:`);
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const testKey = "__elcare_tx_intent_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return window.localStorage;
  } catch {
    // Unavailable (SSR / private mode / quota) — dedup degrades gracefully;
    // the in-memory runningRef guard in useTxLifecycle still applies.
    return null;
  }
}

let cachedChannel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (cachedChannel === undefined) {
    try {
      cachedChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    } catch {
      cachedChannel = null;
    }
  }
  return cachedChannel;
}

function notifyChange(key: string): void {
  try {
    getChannel()?.postMessage({ scopeKey: key, at: Date.now() });
  } catch {
    // ignore — the native `storage` event still delivers cross-tab updates
  }
}

function loadScope(key: string): Record<string, TxIntentRecord> {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, TxIntentRecord>;
  } catch {
    return {};
  }
}

function saveScope(key: string, map: Record<string, TxIntentRecord>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(map));
    }
  } catch {
    // quota / private-mode write failure — non-fatal, dedup just degrades
  }
  notifyChange(key);
}

/** Drops expired and non-pending entries. */
function pruneExpired(
  map: Record<string, TxIntentRecord>,
  now: number = Date.now()
): Record<string, TxIntentRecord> {
  let changed = false;
  const next: Record<string, TxIntentRecord> = {};
  for (const [fp, rec] of Object.entries(map)) {
    if (rec.status === "pending" && rec.expiresAt > now) {
      next[fp] = rec;
    } else {
      changed = true;
    }
  }
  return changed ? next : map;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Scope key for a given network + account — exposed for storage-event filtering. */
export function intentScopeKey(network: string, account: string): string {
  return scopeKey(network, account);
}

/**
 * Registers (or recovers) an intent.
 *
 * If an identical, still-pending, unexpired intent already exists for this
 * account + network, `duplicate: true` is returned along with that record
 * (including its tx hash, once known) instead of registering a new one —
 * callers must NOT invoke their submission function in that case. Otherwise
 * a fresh "pending" record is written and `duplicate: false` is returned.
 */
export function beginIntent(params: BeginIntentParams): BeginIntentResult {
  const windowMs = params.windowMs ?? DEFAULT_INTENT_WINDOW_MS;
  const fingerprint = computeIntentFingerprint(params);
  const key = scopeKey(params.network, params.account);
  const now = Date.now();

  const map = pruneExpired(loadScope(key), now);

  const existing = map[fingerprint];
  if (existing) {
    return { duplicate: true, fingerprint, record: existing };
  }

  const record: TxIntentRecord = {
    fingerprint,
    action: params.action,
    status: "pending",
    txHash: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + windowMs,
  };
  saveScope(key, { ...map, [fingerprint]: record });
  return { duplicate: false, fingerprint, record };
}

/**
 * Updates an in-flight intent's status/hash. A non-"pending" status is
 * terminal and clears the entry immediately — this is what lets a user
 * intentionally retry right after a failure instead of waiting out the
 * validity window.
 */
export function updateIntentStatus(params: UpdateIntentParams): void {
  const key = scopeKey(params.network, params.account);
  const map = loadScope(key);
  const existing = map[params.fingerprint];
  if (!existing) return;

  if (params.status !== "pending") {
    const next = { ...map };
    delete next[params.fingerprint];
    saveScope(key, next);
    return;
  }

  saveScope(key, {
    ...map,
    [params.fingerprint]: {
      ...existing,
      status: params.status,
      txHash: params.txHash ?? existing.txHash,
      updatedAt: Date.now(),
    },
  });
}

/** Explicitly removes one intent (e.g. on manual reset), if present. */
export function clearIntent(network: string, account: string, fingerprint: string): void {
  const key = scopeKey(network, account);
  const map = loadScope(key);
  if (!(fingerprint in map)) return;
  const next = { ...map };
  delete next[fingerprint];
  saveScope(key, next);
}

/** Reads the current record for a fingerprint, pruning expired entries first. */
export function getIntent(
  network: string,
  account: string,
  fingerprint: string
): TxIntentRecord | null {
  const key = scopeKey(network, account);
  const map = pruneExpired(loadScope(key));
  return map[fingerprint] ?? null;
}

/**
 * Subscribes to cross-tab intent changes (BroadcastChannel where available,
 * always falling back to the native `storage` event). The listener receives
 * the affected registry scope key; callers typically compare it against
 * `intentScopeKey(network, account)` before reacting. Returns an unsubscribe
 * function.
 */
export function subscribeToIntentChanges(listener: IntentChangeListener): () => void {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (e: StorageEvent) => {
    if (isRegistryKey(e.key)) listener(e.key);
  };
  window.addEventListener("storage", handleStorage);

  const ch = getChannel();
  const handleMessage = (e: MessageEvent) => {
    const data = e.data as { scopeKey?: string } | undefined;
    if (data?.scopeKey) listener(data.scopeKey);
  };
  ch?.addEventListener("message", handleMessage);

  return () => {
    window.removeEventListener("storage", handleStorage);
    ch?.removeEventListener("message", handleMessage);
  };
}
