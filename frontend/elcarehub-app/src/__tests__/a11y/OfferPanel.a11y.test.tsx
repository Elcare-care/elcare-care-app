import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { OfferPanel, OfferPanelProps } from '@/components/OfferPanel';
import {
  makeIncomingOffer,
  makeOutgoingOffer,
  offerFixtures,
} from '@/__tests__/helpers/fixtures';

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

describe('OfferPanel — offer status fixture coverage', () => {
  const ownerProps: OfferPanelProps = {
    ...baseProps,
    isOwner: true,
    ownerPublicKey: 'GOWNER',
  };

  const buyerProps: OfferPanelProps = {
    ...baseProps,
    isOwner: false,
    ownerPublicKey: 'GOWNER',
  };

  const statusCases: Array<{
    status: string;
    label: RegExp;
    explanation: RegExp;
    terminal: boolean;
  }> = [
    { status: 'pending', label: /pending/i, explanation: /awaiting|pending/i, terminal: false },
    { status: 'accepted', label: /accepted/i, explanation: /accepted/i, terminal: true },
    { status: 'rejected', label: /rejected/i, explanation: /rejected/i, terminal: true },
    { status: 'withdrawn', label: /withdrawn/i, explanation: /withdrawn/i, terminal: true },
    { status: 'expired', label: /expired/i, explanation: /expired/i, terminal: true },
    { status: 'stale', label: /stale/i, explanation: /stale/i, terminal: true },
  ];

  it('inventories the offer fixtures for every status combination', () => {
    expect(offerFixtures).toBeDefined();
    for (const { status } of statusCases) {
      expect(offerFixtures.incoming[status]).toBeDefined();
      expect(offerFixtures.outgoing[status]).toBeDefined();
    }
  });

  describe.each(statusCases)('incoming (owner) offer — $status', ({ status, label, explanation, terminal }) => {
    it('renders the correct status badge label and explanation', () => {
      const offer = makeIncomingOffer({ status });
      render(<OfferPanel {...ownerProps} offers={[offer]} />);

      const badge = screen.getByTestId(`offer-status-badge-${offer.id}`);
      expect(badge).toHaveTextContent(label);
      expect(badge).toHaveAttribute('title');
      expect(badge.getAttribute('title')).toMatch(explanation);
    });

    it(`${terminal ? 'hides' : 'shows'} Accept/Reject actions`, () => {
      const offer = makeIncomingOffer({ status });
      render(<OfferPanel {...ownerProps} offers={[offer]} />);

      const accept = screen.queryByTestId(`accept-offer-${offer.id}`);
      const reject = screen.queryByTestId(`reject-offer-${offer.id}`);

      if (terminal) {
        expect(accept).not.toBeInTheDocument();
        expect(reject).not.toBeInTheDocument();
      } else {
        expect(accept).toBeInTheDocument();
        expect(reject).toBeInTheDocument();
      }
    });
  });

  describe.each(statusCases)('outgoing (buyer) offer — $status', ({ status, label, explanation, terminal }) => {
    it('renders the correct status badge label and explanation', () => {
      const offer = makeOutgoingOffer({ status });
      render(<OfferPanel {...buyerProps} offers={[offer]} />);

      const badge = screen.getByTestId(`offer-status-badge-${offer.id}`);
      expect(badge).toHaveTextContent(label);
      expect(badge).toHaveAttribute('title');
      expect(badge.getAttribute('title')).toMatch(explanation);
    });

    it(`${terminal ? 'hides' : 'shows'} Accept/Reject actions`, () => {
      const offer = makeOutgoingOffer({ status });
      render(<OfferPanel {...buyerProps} offers={[offer]} />);

      const accept = screen.queryByTestId(`accept-offer-${offer.id}`);
      const reject = screen.queryByTestId(`reject-offer-${offer.id}`);

      if (terminal) {
        expect(accept).not.toBeInTheDocument();
        expect(reject).not.toBeInTheDocument();
      } else {
        expect(accept).toBeInTheDocument();
        expect(reject).toBeInTheDocument();
      }
    });
  });

  it('renders the empty-state copy when there are no offers', () => {
    render(<OfferPanel {...ownerProps} offers={[]} />);
    expect(screen.getByTestId('offers-empty-state')).toHaveTextContent(/no offers/i);
  });

  it('renders the empty-state copy for buyers when there are no offers', () => {
    render(<OfferPanel {...buyerProps} offers={[]} />);
    expect(screen.getByTestId('offers-empty-state')).toHaveTextContent(/no offers/i);
  });
});
