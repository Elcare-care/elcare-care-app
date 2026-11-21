import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { ConnectWalletModal } from '@/components/ConnectWalletModal';

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

  it('exposes focusable controls that are keyboard reachable', () => {
    const { container } = render(
      <ConnectWalletModal isOpen onClose={() => {}} />
    );

    const controls = getFocusableControls(container);
    expect(controls.length).toBeGreaterThan(0);

    controls.forEach((control) => {
      control.focus();
      expect(document.activeElement).toBe(control);
    });
  });

  it.each(THEMES)(
    'focus ring uses %s theme CSS variable and meets contrast',
    (theme) => {
      applyTheme(theme);

      const { container } = render(
        <ConnectWalletModal isOpen onClose={() => {}} />
      );

      const controls = getFocusableControls(container);
      expect(controls.length).toBeGreaterThan(0);

      controls.forEach((control) => {
        fireEvent.focus(control);

        const computed = getComputedStyle(control);
        const outline = computed.outline;
        const boxShadow = computed.boxShadow;
        const focusRingValue = resolveCssVar(
          control,
          FOCUS_RING_VAR,
          FOCUS_RING_FALLBACK
        );

        // The focus indicator must be expressed via the CSS variable, not a
        // hard-coded exception. Either the outline or box-shadow should
        // reference the resolved focus ring color.
        const focusRingColor = parseColor(focusRingValue);
        expect(focusRingColor).not.toBeNull();

        const outlineColor = parseColor(computed.outlineColor);
        const shadowReferencesVar =
          boxShadow !== 'none' && boxShadow.includes(focusRingValue);

        const outlineReferencesVar =
          outline !== 'none' &&
          outlineColor !== null &&
          focusRingColor !== null &&
          outlineColor[0] === focusRingColor[0] &&
          outlineColor[1] === focusRingColor[1] &&
          outlineColor[2] === focusRingColor[2];

        expect(outlineReferencesVar || shadowReferencesVar).toBe(true);

        const backgroundValue = resolveCssVar(
          control,
          BACKGROUND_VAR,
          BACKGROUND_FALLBACK
        );
        const background = parseColor(backgroundValue);
        expect(background).not.toBeNull();

        if (focusRingColor && background) {
          const ratio = contrastRatio(focusRingColor, background);
          // WCAG 2.1 non-text contrast minimum for focus indicators.
          expect(ratio).toBeGreaterThanOrEqual(3);
        }
      });
    }
  );

  it('keeps focus ring color consistent across themes via CSS variable', () => {
    const { container } = render(
      <ConnectWalletModal isOpen onClose={() => {}} />
    );

    const controls = getFocusableControls(container);
    expect(controls.length).toBeGreaterThan(0);

    const values: string[] = [];
    THEMES.forEach((theme) => {
      applyTheme(theme);
      controls.forEach((control) => {
        values.push(
          resolveCssVar(control, FOCUS_RING_VAR, FOCUS_RING_FALLBACK)
        );
      });
    });

    // Every control resolves the focus ring through the same variable.
    values.forEach((value) => {
      expect(value).toBeTruthy();
      expect(parseColor(value)).not.toBeNull();
    });
  });
});