import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

const mockLoginWithEmail = jest.fn();
const mockLoginWithPasskey = jest.fn();

let mockStatus = 'DISCONNECTED';
let mockError: string | null = null;

jest.mock('@/hooks/useMagicWallet', () => ({
  useMagicWallet: () => ({
    status: mockStatus,
    isConnecting: false,
    error: mockError,
    email: null,
    publicAddress: null,
    loginWithEmail: mockLoginWithEmail,
    loginWithPasskey: mockLoginWithPasskey,
  }),
}));

jest.mock('lucide-react', () =>
  Object.fromEntries(
    ['X', 'Mail', 'Fingerprint', 'ExternalLink', 'AlertTriangle', 'ArrowRight', 'Loader2', 'CheckCircle2'].map(
      (name) => [name, () => <span />]
    )
  )
);

import { MagicWalletModal } from '@/components/MagicWalletModal';

describe('MagicWalletModal accessibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStatus = 'DISCONNECTED';
    mockError = null;
  });

  it('has no axe violations in the wallet-chooser state', async () => {
    const { container } = render(<MagicWalletModal isOpen onClose={() => {}} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations with the email form and a validation error shown', async () => {
    mockError = 'Failed to send OTP. Please check your email address.';
    const user = userEvent.setup();
    const { container } = render(<MagicWalletModal isOpen onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: /email magic link/i }));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('exposes dialog semantics with an accessible name and description', () => {
    render(<MagicWalletModal isOpen onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/magic wallet/i);
    expect(dialog).toHaveAccessibleDescription(/create a wallet/i);
  });

  it('marks the email field invalid and links it to the error message', async () => {
    mockError = 'Login session timed out. Please try again.';
    const user = userEvent.setup();
    render(<MagicWalletModal isOpen onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: /email magic link/i }));

    const input = screen.getByLabelText(/email address/i);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(/login session timed out/i);
  });
});
