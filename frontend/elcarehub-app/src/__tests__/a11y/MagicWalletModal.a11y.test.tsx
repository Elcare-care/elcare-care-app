import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

const mockLoginWithEmail = jest.fn();
const mockLoginWithPasskey = jest.fn();

let mockStatus = 'DISCONNECTED';
let mockError: string | null = null;

type MagicValidationCase = {
  name: string;
  email?: string;
  expectedEmail?: string;
  expectEmailCall: boolean;
  expectPasskeyCall: boolean;
  providerError?: string;
  expectedError?: RegExp;
};

const magicValidationCases: MagicValidationCase[] = [
  {
    name: 'blank email blocks submission',
    email: '   ',
    expectEmailCall: false,
    expectPasskeyCall: false,
  },
  {
    name: 'malformed email surfaces a validation error',
    email: 'not-an-email',
    expectEmailCall: false,
    expectPasskeyCall: false,
    expectedError: /valid email/i,
  },
  {
    name: 'valid email calls loginWithEmail with the value',
    email: 'user@example.com',
    expectedEmail: 'user@example.com',
    expectEmailCall: true,
    expectPasskeyCall: false,
  },
  {
    name: 'valid passkey calls loginWithPasskey',
    expectEmailCall: false,
    expectPasskeyCall: true,
  },
  {
    name: 'provider failure surfaces the error message',
    email: 'user@example.com',
    expectedEmail: 'user@example.com',
    expectEmailCall: true,
    expectPasskeyCall: false,
    providerError: 'Provider unavailable. Please try again.',
    expectedError: /provider unavailable/i,
  },
];

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

  describe('validation fixture matrix', () => {
    beforeEach(() => {
      mockLoginWithEmail.mockReset();
      mockLoginWithPasskey.mockReset();
    });

    it.each(magicValidationCases)('$name', async (testCase) => {
      if (testCase.providerError) {
        mockLoginWithEmail.mockRejectedValueOnce(new Error(testCase.providerError));
      } else {
        mockLoginWithEmail.mockResolvedValueOnce(undefined);
      }
      mockLoginWithPasskey.mockResolvedValueOnce(undefined);

      const user = userEvent.setup();
      render(<MagicWalletModal isOpen onClose={() => {}} />);

      if (testCase.email !== undefined) {
        await user.click(screen.getByRole('button', { name: /email magic link/i }));
        await user.type(screen.getByLabelText(/email address/i), testCase.email);
        await user.click(screen.getByRole('button', { name: /send magic link|continue|sign in/i }));
      } else {
        await user.click(screen.getByRole('button', { name: /passkey/i }));
      }

      if (testCase.expectEmailCall) {
        expect(mockLoginWithEmail).toHaveBeenCalledTimes(1);
        expect(mockLoginWithEmail).toHaveBeenCalledWith(testCase.expectedEmail);
      } else {
        expect(mockLoginWithEmail).not.toHaveBeenCalled();
      }

      if (testCase.expectPasskeyCall) {
        expect(mockLoginWithPasskey).toHaveBeenCalledTimes(1);
      } else {
        expect(mockLoginWithPasskey).not.toHaveBeenCalled();
      }

      if (testCase.expectedError) {
        const liveRegion = document.querySelector('[aria-live="assertive"]');
        expect(liveRegion).toBeTruthy();
        await waitFor(() => {
          expect(liveRegion).toHaveTextContent(testCase.expectedError as RegExp);
        });
      }

      // No real credentials or external calls: only the mocked hooks are exercised.
      expect(mockLoginWithEmail.mock.calls.flat()).not.toContain(undefined);
    });
  });
});
