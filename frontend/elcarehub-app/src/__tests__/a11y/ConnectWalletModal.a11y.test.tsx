import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { ConnectWalletModal } from '@/components/ConnectWalletModal';
import { a11yFixtures } from '@/__tests__/a11y/a11yFixtures';

jest.mock('posthog-js', () => ({ capture: jest.fn() }));

jest.mock('@/context/WalletContext', () => ({
  useWalletContext: () => ({
    isConnected: false,
    publicKey: null,
    refresh: jest.fn(),
    freighter: {
      isConnecting: false,
      isInstalled: true,
      isWrongNetwork: false,
      error: null,
    },
    lobstr: {
      isConnecting: false,
      isInstalled: true,
      isWrongNetwork: false,
      error: null,
    },
    magic: { isConnecting: false, isConnected: false, error: null },
    connectFreighter: jest.fn(),
    connectLobstr: jest.fn(),
  }),
}));

jest.mock('@/components/MagicWalletModal', () => ({
  MagicWalletModal: () => null,
}));

jest.mock('lucide-react', () =>
  Object.fromEntries(
    [
      'X',
      'Wallet',
      'ExternalLink',
      'ShieldCheck',
      'AlertTriangle',
      'ArrowRight',
      'Loader2',
      'CheckCircle2',
      'Mail',
    ].map((name) => [name, () => <span />])
  )
);

const FOCUS_RING_VAR = '--focus-ring-color';
const FOCUS_RING_FALLBACK = '#2563eb';
const BACKGROUND_VAR = '--background';
const BACKGROUND_FALLBACK = '#ffffff';

const THEMES = ['light', 'dark'] as const;

/**
 * Parse a CSS color string (hex or rgb/rgba) into an [r, g, b] tuple.
 * Returns null when the value cannot be parsed.
 */
function parseColor(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const hexMatch = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }

  const rgbMatch = trimmed.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i
  );
  if (rgbMatch) {
    return [
      parseInt(rgbMatch[1], 10),
      parseInt(rgbMatch[2], 10),
      parseInt(rgbMatch[3], 10),
    ];
  }

  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(
  a: [number, number, number],
  b: [number, number, number]
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function resolveCssVar(
  element: HTMLElement,
  name: string,
  fallback: string
): string {
  const computed = getComputedStyle(element);
  const value = computed.getPropertyValue(name).trim();
  return value || fallback;
}

function getFocusableControls(container: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute('aria-hidden') && el.offsetParent !== null
  );
}

function applyTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

describe('ConnectWalletModal accessibility', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark');
  });

  it('has no axe violations when open', async () => {
    const { container } = render(
      <ConnectWalletModal isOpen onClose={() => {}} />
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  describe('keyboard interactions', () => {
    const { escape, tabWrap, focusReturn } =
      a11yFixtures.keyboard.walletConnect;

    it('closes the modal and calls onClose when Escape is pressed', async () => {
      const user = userEvent.setup();
      const onClose = jest.fn();

      render(<ConnectWalletModal isOpen onClose={onClose} />);

      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.keyboard(escape.key);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('wraps focus from the last focusable element to the first on Tab', async () => {
      const user = userEvent.setup();

      render(<ConnectWalletModal isOpen onClose={() => {}} />);

      const dialog = screen.getByRole('dialog');
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

      expect(focusables.length).toBeGreaterThan(1);

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      last.focus();
      expect(document.activeElement).toBe(last);

      await user.tab({ shift: tabWrap.shift });

      await waitFor(() => {
        expect(document.activeElement).toBe(first);
      });
    });

    it('wraps focus from the first focusable element to the last on Shift+Tab', async () => {
      const user = userEvent.setup();

      render(<ConnectWalletModal isOpen onClose={() => {}} />);

      const dialog = screen.getByRole('dialog');
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

      expect(focusables.length).toBeGreaterThan(1);

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      first.focus();
      expect(document.activeElement).toBe(first);

      await user.tab({ shift: !tabWrap.shift });

      await waitFor(() => {
        expect(document.activeElement).toBe(last);
      });
    });

    it('returns focus to the trigger button after the modal closes', async () => {
      const user = userEvent.setup();
      const onClose = jest.fn();

      const Trigger = () => {
        const [open, setOpen] = React.useState(false);
        return (
          <>
            <button
              type="button"
              onClick={() => setOpen(true)}
              data-testid="wallet-trigger"
            >
              Connect Wallet
            </button>
            <ConnectWalletModal
              isOpen={open}
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            />
          </>
        );
      };

      render(<Trigger />);

      const trigger = screen.getByTestId('wallet-trigger');
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      await user.click(trigger);

      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.keyboard(escape.key);

      expect(onClose).toHaveBeenCalledTimes(1);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      await waitFor(() => {
        expect(document.activeElement).toBe(trigger);
      });

      expect(focusReturn.returnsToTrigger).toBe(true);
    });
  });
});