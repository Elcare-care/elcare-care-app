// ─────────────────────────────────────────────────────────────
// lib/wallet-preferences.ts — User wallet privacy preferences
//
// Manages user-controlled wallet persistence behavior.
// Persisted in localStorage (user choice, not wallet data).
// ─────────────────────────────────────────────────────────────

const PREFERENCES_KEY = 'elcare.wallet.preferences';

export interface WalletPreferences {
  /** Should wallet connection persist across sessions? Default: true (opt-out) */
  rememberWallet: boolean;
  /** Should we automatically reconnect on app load? Default: true */
  autoConnect: boolean;
}

const DEFAULT_PREFERENCES: WalletPreferences = {
  rememberWallet: true,
  autoConnect: true,
};

/**
 * Read wallet preferences from localStorage.
 * Returns defaults if not set or corrupted.
 */
export function getWalletPreferences(): WalletPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;

  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    if (!stored) return DEFAULT_PREFERENCES;

    const parsed = JSON.parse(stored) as Partial<WalletPreferences>;
    return {
      rememberWallet: parsed.rememberWallet ?? DEFAULT_PREFERENCES.rememberWallet,
      autoConnect: parsed.autoConnect ?? DEFAULT_PREFERENCES.autoConnect,
    };
  } catch (err) {
    console.debug('[wallet-preferences] Failed to parse preferences, using defaults', err);
    return DEFAULT_PREFERENCES;
  }
}

/**
 * Persist wallet preferences to localStorage.
 * Partial update — only keys provided will be changed.
 */
export function setWalletPreferences(updates: Partial<WalletPreferences>): void {
  if (typeof window === 'undefined') return;

  try {
    const current = getWalletPreferences();
    const updated: WalletPreferences = { ...current, ...updates };
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('[wallet-preferences] Failed to persist preferences', err);
  }
}

/**
 * Clear all wallet preferences (used on full logout).
 */
export function clearWalletPreferences(): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.removeItem(PREFERENCES_KEY);
  } catch {
    // Ignore
  }
}
