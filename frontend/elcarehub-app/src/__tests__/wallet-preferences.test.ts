/**
 * Tests for wallet-preferences.ts
 */
import {
  getWalletPreferences,
  setWalletPreferences,
  clearWalletPreferences,
  WalletPreferences,
} from '@/lib/wallet-preferences';

describe('wallet-preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('getWalletPreferences', () => {
    it('returns defaults when nothing is stored', () => {
      const prefs = getWalletPreferences();
      expect(prefs.rememberWallet).toBe(true);
      expect(prefs.autoConnect).toBe(true);
    });

    it('returns stored preferences', () => {
      const stored: WalletPreferences = { rememberWallet: false, autoConnect: false };
      localStorage.setItem('elcare.wallet.preferences', JSON.stringify(stored));

      const prefs = getWalletPreferences();
      expect(prefs.rememberWallet).toBe(false);
      expect(prefs.autoConnect).toBe(false);
    });

    it('returns defaults for missing keys', () => {
      const partial = { rememberWallet: false };
      localStorage.setItem('elcare.wallet.preferences', JSON.stringify(partial));

      const prefs = getWalletPreferences();
      expect(prefs.rememberWallet).toBe(false);
      expect(prefs.autoConnect).toBe(true); // Default
    });

    it('returns defaults when JSON is corrupted', () => {
      localStorage.setItem('elcare.wallet.preferences', 'invalid json {{{');

      const prefs = getWalletPreferences();
      expect(prefs.rememberWallet).toBe(true);
      expect(prefs.autoConnect).toBe(true);
    });

    it('returns defaults outside browser environment', () => {
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      const prefs = getWalletPreferences();
      expect(prefs.rememberWallet).toBe(true);
      expect(prefs.autoConnect).toBe(true);

      global.window = originalWindow;
    });
  });

  describe('setWalletPreferences', () => {
    it('persists new preferences to localStorage', () => {
      setWalletPreferences({ rememberWallet: false, autoConnect: false });

      const stored = localStorage.getItem('elcare.wallet.preferences');
      expect(stored).toBeTruthy();

      const parsed = JSON.parse(stored!) as WalletPreferences;
      expect(parsed.rememberWallet).toBe(false);
      expect(parsed.autoConnect).toBe(false);
    });

    it('performs partial update (does not overwrite unspecified keys)', () => {
      // Set initial values
      setWalletPreferences({ rememberWallet: false, autoConnect: false });

      // Update only one key
      setWalletPreferences({ rememberWallet: true });

      const prefs = getWalletPreferences();
      expect(prefs.rememberWallet).toBe(true); // Updated
      expect(prefs.autoConnect).toBe(false); // Preserved
    });

    it('handles storage write failures gracefully', () => {
      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new QuotaExceededError('Storage full');
      });

      expect(() => setWalletPreferences({ rememberWallet: false })).not.toThrow();

      spy.mockRestore();
    });

    it('does nothing outside browser environment', () => {
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      expect(() => setWalletPreferences({ rememberWallet: false })).not.toThrow();

      global.window = originalWindow;
    });
  });

  describe('clearWalletPreferences', () => {
    it('removes preferences from localStorage', () => {
      setWalletPreferences({ rememberWallet: false });
      expect(localStorage.getItem('elcare.wallet.preferences')).toBeTruthy();

      clearWalletPreferences();

      expect(localStorage.getItem('elcare.wallet.preferences')).toBeNull();
    });

    it('handles clearing when nothing is stored', () => {
      expect(() => clearWalletPreferences()).not.toThrow();
    });

    it('handles storage removal failures gracefully', () => {
      const spy = jest.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
        throw new SecurityError('Storage denied');
      });

      expect(() => clearWalletPreferences()).not.toThrow();

      spy.mockRestore();
    });

    it('does nothing outside browser environment', () => {
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      expect(() => clearWalletPreferences()).not.toThrow();

      global.window = originalWindow;
    });
  });
});
