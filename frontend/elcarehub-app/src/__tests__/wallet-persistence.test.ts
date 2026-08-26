/**
 * Tests for wallet-persistence.ts with schema versioning, expiration, corruption handling
 */
import {
  saveWalletState,
  loadWalletState,
  clearWalletState,
  clearPendingActionState,
  getRememberWalletPreference,
  setRememberWalletPreference,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_WALLET_TTL_MS,
  WalletPersistenceSchema,
  // Legacy functions for backwards compat
  saveWalletProvider,
  loadWalletProvider,
  clearWalletProvider,
} from '@/lib/wallet-persistence';

describe('wallet-persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    jest.clearAllMocks();
    // Always start with remember=true (default)
    localStorage.setItem('elcare.wallet.remember', 'true');
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('saveWalletState', () => {
    it('persists wallet state to localStorage by default', () => {
      const result = saveWalletState('GCAT...ZXAB', 'freighter', 1);
      expect(result).toBe(true);

      const stored = localStorage.getItem('elcare.wallet.state.v1');
      expect(stored).toBeTruthy();

      const parsed = JSON.parse(stored!) as WalletPersistenceSchema;
      expect(parsed.version).toBe(CURRENT_SCHEMA_VERSION);
      expect(parsed.walletAddress).toBe('GCAT...ZXAB');
      expect(parsed.connectorId).toBe('freighter');
      expect(parsed.chainId).toBe(1);
    });

    it('sets correct expiration timestamp (lastUsed + TTL)', () => {
      const before = Date.now();
      saveWalletState('GCAT...ZXAB', 'freighter', 1);
      const after = Date.now();

      const stored = localStorage.getItem('elcare.wallet.state.v1')!;
      const parsed = JSON.parse(stored) as WalletPersistenceSchema;

      expect(parsed.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_WALLET_TTL_MS);
      expect(parsed.expiresAt).toBeLessThanOrEqual(after + DEFAULT_WALLET_TTL_MS);
    });

    it('accepts custom TTL override', () => {
      const customTtl = 60 * 60 * 1000; // 1 hour
      const before = Date.now();
      saveWalletState('GCAT...ZXAB', 'freighter', 1, { ttlMs: customTtl });
      const after = Date.now();

      const stored = localStorage.getItem('elcare.wallet.state.v1')!;
      const parsed = JSON.parse(stored) as WalletPersistenceSchema;

      expect(parsed.expiresAt).toBeGreaterThanOrEqual(before + customTtl);
      expect(parsed.expiresAt).toBeLessThanOrEqual(after + customTtl);
    });

    it('accepts all valid connector types', () => {
      const connectors = ['freighter', 'lobstr', 'magic'] as const;
      connectors.forEach((connector) => {
        localStorage.clear();
        const result = saveWalletState('GCAT...ZXAB', connector, 1);
        expect(result).toBe(true);

        const stored = localStorage.getItem('elcare.wallet.state.v1')!;
        const parsed = JSON.parse(stored) as WalletPersistenceSchema;
        expect(parsed.connectorId).toBe(connector);
      });
    });

    it('respects rememberWallet preference (uses localStorage when true)', () => {
      localStorage.setItem('elcare.wallet.remember', 'true');
      saveWalletState('GCAT...ZXAB', 'freighter', 1);

      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeTruthy();
      expect(sessionStorage.getItem('elcare.wallet.state.v1')).toBeNull();
    });

    it('respects rememberWallet preference (uses sessionStorage when false)', () => {
      localStorage.setItem('elcare.wallet.remember', 'false');
      saveWalletState('GCAT...ZXAB', 'freighter', 1);

      expect(sessionStorage.getItem('elcare.wallet.state.v1')).toBeTruthy();
      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeNull();
    });
  });

  describe('loadWalletState', () => {
    it('returns null when nothing persisted', () => {
      const result = loadWalletState();
      expect(result).toBeNull();
    });

    it('loads valid persisted wallet state', () => {
      saveWalletState('GCAT...ZXAB', 'magic', 42);

      const result = loadWalletState();
      expect(result).not.toBeNull();
      expect(result!.walletAddress).toBe('GCAT...ZXAB');
      expect(result!.connectorId).toBe('magic');
      expect(result!.chainId).toBe(42);
    });

    it('clears and returns null when expired', () => {
      saveWalletState('GCAT...ZXAB', 'freighter', 1);

      // Manually set expiry to past
      const stored = localStorage.getItem('elcare.wallet.state.v1')!;
      const parsed = JSON.parse(stored) as WalletPersistenceSchema;
      parsed.expiresAt = Date.now() - 1000; // 1 second ago
      localStorage.setItem('elcare.wallet.state.v1', JSON.stringify(parsed));

      const result = loadWalletState();
      expect(result).toBeNull();
      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeNull(); // Cleared
    });

    it('clears and returns null when JSON is corrupted', () => {
      localStorage.setItem('elcare.wallet.state.v1', 'not valid json {{{');

      const result = loadWalletState();
      expect(result).toBeNull();
      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeNull(); // Corrupted key cleared
    });

    it('clears and returns null on schema version mismatch', () => {
      const schema: WalletPersistenceSchema = {
        version: 999, // Unsupported version
        walletAddress: 'GCAT...ZXAB',
        connectorId: 'freighter',
        lastUsed: Date.now(),
        expiresAt: Date.now() + DEFAULT_WALLET_TTL_MS,
        chainId: 1,
      };
      localStorage.setItem('elcare.wallet.state.v1', JSON.stringify(schema));

      const result = loadWalletState();
      expect(result).toBeNull();
      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeNull(); // Cleared
    });

    it('clears and returns null when required fields are missing', () => {
      const incomplete = {
        version: CURRENT_SCHEMA_VERSION,
        walletAddress: 'GCAT...ZXAB',
        // Missing connectorId
        lastUsed: Date.now(),
        expiresAt: Date.now() + DEFAULT_WALLET_TTL_MS,
        chainId: 1,
      };
      localStorage.setItem('elcare.wallet.state.v1', JSON.stringify(incomplete));

      const result = loadWalletState();
      expect(result).toBeNull();
      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeNull();
    });

    it('respects rememberWallet preference (loads from localStorage when true)', () => {
      localStorage.setItem('elcare.wallet.remember', 'true');
      localStorage.setItem('elcare.wallet.state.v1', JSON.stringify({
        version: CURRENT_SCHEMA_VERSION,
        walletAddress: 'GCAT...ZXAB',
        connectorId: 'freighter',
        lastUsed: Date.now(),
        expiresAt: Date.now() + DEFAULT_WALLET_TTL_MS,
        chainId: 1,
      }));

      const result = loadWalletState();
      expect(result).not.toBeNull();
      expect(result!.walletAddress).toBe('GCAT...ZXAB');
    });

    it('respects rememberWallet preference (loads from sessionStorage when false)', () => {
      localStorage.setItem('elcare.wallet.remember', 'false');
      sessionStorage.setItem('elcare.wallet.state.v1', JSON.stringify({
        version: CURRENT_SCHEMA_VERSION,
        walletAddress: 'GCAT...ZXAB',
        connectorId: 'lobstr',
        lastUsed: Date.now(),
        expiresAt: Date.now() + DEFAULT_WALLET_TTL_MS,
        chainId: 1,
      }));

      const result = loadWalletState();
      expect(result).not.toBeNull();
      expect(result!.connectorId).toBe('lobstr');
    });

    it('falls back gracefully when both storages are unavailable', () => {
      const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new SecurityError('Storage denied');
      });

      const result = loadWalletState();
      expect(result).toBeNull(); // Graceful fallback

      spy.mockRestore();
    });
  });

  describe('clearWalletState', () => {
    it('removes persisted wallet state from active storage', () => {
      saveWalletState('GCAT...ZXAB', 'freighter', 1);
      clearWalletState();

      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeNull();
      expect(sessionStorage.getItem('elcare.wallet.state.v1')).toBeNull();
    });

    it('clears pending action state on account switch', () => {
      localStorage.setItem('elcare.wallet.pending_account', '{"data":"test"}');
      clearWalletState();

      expect(localStorage.getItem('elcare.wallet.pending_account')).toBeNull();
    });

    it('clears pending action state independently', () => {
      localStorage.setItem('elcare.wallet.pending_account', '{"data":"test"}');
      clearPendingActionState();

      expect(localStorage.getItem('elcare.wallet.pending_account')).toBeNull();
    });

    it('handles clearing when storage is unavailable', () => {
      const spy = jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new SecurityError('Storage denied');
      });

      expect(() => clearWalletState()).not.toThrow(); // Should not crash

      spy.mockRestore();
    });
  });

  describe('getRememberWalletPreference', () => {
    it('returns true by default (opt-out model)', () => {
      localStorage.removeItem('elcare.wallet.remember');
      expect(getRememberWalletPreference()).toBe(true);
    });

    it('returns stored preference when set', () => {
      localStorage.setItem('elcare.wallet.remember', 'false');
      expect(getRememberWalletPreference()).toBe(false);

      localStorage.setItem('elcare.wallet.remember', 'true');
      expect(getRememberWalletPreference()).toBe(true);
    });

    it('returns true when value is corrupted', () => {
      localStorage.setItem('elcare.wallet.remember', 'invalid');
      expect(getRememberWalletPreference()).toBe(true); // Default
    });

    it('returns true outside browser environment', () => {
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      expect(getRememberWalletPreference()).toBe(true);

      global.window = originalWindow;
    });
  });

  describe('setRememberWalletPreference', () => {
    it('persists preference to localStorage', () => {
      setRememberWalletPreference(false);
      expect(localStorage.getItem('elcare.wallet.remember')).toBe('false');

      setRememberWalletPreference(true);
      expect(localStorage.getItem('elcare.wallet.remember')).toBe('true');
    });

    it('clears localStorage wallet data when disabling remember', () => {
      saveWalletState('GCAT...ZXAB', 'freighter', 1);
      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeTruthy();

      setRememberWalletPreference(false);
      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeNull(); // Cleared
    });

    it('does not clear sessionStorage when disabling remember', () => {
      localStorage.setItem('elcare.wallet.remember', 'false');
      saveWalletState('GCAT...ZXAB', 'freighter', 1); // Goes to sessionStorage
      expect(sessionStorage.getItem('elcare.wallet.state.v1')).toBeTruthy();

      setRememberWalletPreference(false);
      // sessionStorage should remain (not cleared)
      expect(sessionStorage.getItem('elcare.wallet.state.v1')).toBeTruthy();
    });

    it('handles storage write failures gracefully', () => {
      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new QuotaExceededError('Storage full');
      });

      expect(() => setRememberWalletPreference(false)).not.toThrow();

      spy.mockRestore();
    });
  });

  describe('backwards compatibility', () => {
    it('saveWalletProvider persists to new schema', () => {
      saveWalletProvider('magic');

      const stored = localStorage.getItem('elcare.wallet.state.v1');
      expect(stored).toBeTruthy();

      const parsed = JSON.parse(stored!) as WalletPersistenceSchema;
      expect(parsed.connectorId).toBe('magic');
    });

    it('saveWalletProvider also updates old keys for legacy code', () => {
      saveWalletProvider('lobstr');

      // New schema
      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeTruthy();

      // Old keys (for backwards compat)
      expect(localStorage.getItem('elcare.wallet.provider')).toBe('lobstr');
      expect(localStorage.getItem('elcare.wallet.expiry')).toBeTruthy();
    });

    it('loadWalletProvider tries new schema first, then falls back to old keys', () => {
      // Test new schema
      saveWalletState('GCAT...ZXAB', 'freighter', 1);
      expect(loadWalletProvider()).toBe('freighter');

      localStorage.clear();

      // Test old schema fallback
      localStorage.setItem('elcare.wallet.provider', 'magic');
      localStorage.setItem('elcare.wallet.expiry', String(Date.now() + 86400000));
      expect(loadWalletProvider()).toBe('magic');
    });

    it('loadWalletProvider returns null when both schemas are expired', () => {
      localStorage.setItem('elcare.wallet.provider', 'freighter');
      localStorage.setItem('elcare.wallet.expiry', String(Date.now() - 1000));

      expect(loadWalletProvider()).toBeNull();
      expect(localStorage.getItem('elcare.wallet.provider')).toBeNull(); // Cleared
    });

    it('clearWalletProvider clears both old and new keys', () => {
      saveWalletProvider('freighter');
      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeTruthy();
      expect(localStorage.getItem('elcare.wallet.provider')).toBeTruthy();

      clearWalletProvider();

      expect(localStorage.getItem('elcare.wallet.state.v1')).toBeNull();
      expect(localStorage.getItem('elcare.wallet.provider')).toBeNull();
      expect(localStorage.getItem('elcare.wallet.expiry')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles account switching with pending action state', () => {
      // User action in progress for account A
      localStorage.setItem('elcare.wallet.pending_account', JSON.stringify({ action: 'approve', amount: 100 }));

      // User switches to account B
      clearPendingActionState();
      saveWalletState('GCAT...YYZZ', 'freighter', 1);

      // Pending state is cleared
      expect(localStorage.getItem('elcare.wallet.pending_account')).toBeNull();

      // New account is saved
      const loaded = loadWalletState();
      expect(loaded!.walletAddress).toBe('GCAT...YYZZ');
    });

    it('handles rapid connect/disconnect cycles', () => {
      saveWalletState('GCAT...ZXAB', 'freighter', 1);
      clearWalletState();
      saveWalletState('GCAT...YYZZ', 'lobstr', 2);
      clearWalletState();

      expect(loadWalletState()).toBeNull();
    });

    it('handles very long wallet addresses', () => {
      const longAddress = 'G' + 'A'.repeat(100);
      const result = saveWalletState(longAddress, 'freighter', 1);
      expect(result).toBe(true);

      const loaded = loadWalletState();
      expect(loaded!.walletAddress).toBe(longAddress);
    });

    it('handles storage quota exceeded gracefully', () => {
      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new Error('QuotaExceededError: The quota has been exceeded.');
      });

      const result = saveWalletState('GCAT...ZXAB', 'freighter', 1);
      expect(result).toBe(false); // Failed to save, but no crash

      spy.mockRestore();
    });

    it('handles security errors (private browsing) gracefully', () => {
      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new SecurityError('Storage not available');
      });

      const result = saveWalletState('GCAT...ZXAB', 'freighter', 1);
      expect(result).toBe(false); // Failed to save, but no crash

      spy.mockRestore();
    });
  });
});

