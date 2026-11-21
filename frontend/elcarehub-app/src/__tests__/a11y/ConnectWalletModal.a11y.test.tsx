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

describe('ConnectWalletModal accessibility', () => {
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