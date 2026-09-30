import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { OfferPanel, OfferPanelProps } from '@/components/OfferPanel';

jest.mock('@/context/WalletContext', () => ({
  useWalletContext: () => ({ isConnected: true, isWrongNetwork: false }),
}));

jest.mock('@/components/WalletGuard', () => ({
  GuardButton: ({ children, onAction, ...rest }: any) => (
    <button onClick={onAction} {...rest}>
      {children}
    </button>
  ),
}));

jest.mock('@/config/tokens', () => ({
  SUPPORTED_TOKENS: [
    { symbol: 'XLM', name: 'Stellar Lumens', address: 'CTOKEN_XLM', decimals: 7 },
  ],
}));

jest.mock('@/hooks/useOffers', () => ({
  useAcceptOffer: () => ({ accept: jest.fn(), isAccepting: false, error: null }),
  useRejectOffer: () => ({ reject: jest.fn(), isRejecting: false, error: null }),
}));

jest.mock('lucide-react', () =>
  Object.fromEntries(
    [
      'HandCoins',
      'CheckCircle',
      'XCircle',
      'Loader2',
      'CalendarClock',
      'ChevronDown',
      'AlertCircle',
      'TrendingUp',
      'User',
      'X',
    ].map((name) => [name, () => <span />])
  )
);

const baseProps: OfferPanelProps = {
  listingId: 42,
  listingToken: 'CTOKEN_XLM',
  isOwner: false,
  offers: [],
  isLoadingOffers: false,
  onRefreshOffers: jest.fn(),
  onMakeOffer: jest.fn().mockResolvedValue(true),
  isMakingOffer: false,
  makeOfferError: null,
  isActive: true,
  ownerPublicKey: null,
};

describe('OfferPanel — Make Offer modal accessibility', () => {
  it('has no axe violations when the modal is open', async () => {
    const user = userEvent.setup();
    const { container } = render(<OfferPanel {...baseProps} />);

    await user.click(screen.getByTestId('make-offer-trigger'));
    expect(screen.getByTestId('make-offer-modal')).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations with a validation error shown', async () => {
    const user = userEvent.setup();
    const { container } = render(<OfferPanel {...baseProps} makeOfferError="Offer amount must be positive." />);

    await user.click(screen.getByTestId('make-offer-trigger'));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('marks the amount field invalid and links it to the error banner', async () => {
    const user = userEvent.setup();
    render(<OfferPanel {...baseProps} makeOfferError="Offer amount must be positive." />);

    await user.click(screen.getByTestId('make-offer-trigger'));
    const input = screen.getByTestId('offer-amount-input');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(/offer amount must be positive/i);
  });
});
