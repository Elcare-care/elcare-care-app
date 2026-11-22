import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock next/navigation so the profile route can be rendered in isolation.
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
    replace: mockReplace,
    prefetch: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
  }),
  usePathname: () => '/profile',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// Mock the contract/indexer client so we can assert it is never called for
// invalid wallet addresses.
const mockGetProfile = jest.fn();
const mockGetProfileByAddress = jest.fn();
const mockFetchProfile = jest.fn();

jest.mock('@/lib/contractClient', () => ({
  __esModule: true,
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  getProfileByAddress: (...args: unknown[]) => mockGetProfileByAddress(...args),
  fetchProfile: (...args: unknown[]) => mockFetchProfile(...args),
  default: {
    getProfile: (...args: unknown[]) => mockGetProfile(...args),
    getProfileByAddress: (...args: unknown[]) => mockGetProfileByAddress(...args),
    fetchProfile: (...args: unknown[]) => mockFetchProfile(...args),
  },
}));

jest.mock('@/lib/indexerClient', () => ({
  __esModule: true,
  fetchProfile: (...args: unknown[]) => mockFetchProfile(...args),
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  default: {
    fetchProfile: (...args: unknown[]) => mockFetchProfile(...args),
    getProfile: (...args: unknown[]) => mockGetProfile(...args),
  },
}));

// Import the component under test after mocks are registered.
import ProfileClient from '@/app/profile/[address]/ProfileClient';
import {
  INVALID_PROFILE_ADDRESSES,
  MALFORMED_PROFILE_ADDRESS,
  EMPTY_PROFILE_ADDRESS,
} from './fixtures/profileAddressFixtures';

function assertNoContractCalls() {
  expect(mockGetProfile).not.toHaveBeenCalled();
  expect(mockGetProfileByAddress).not.toHaveBeenCalled();
  expect(mockFetchProfile).not.toHaveBeenCalled();
}

describe('Profile route - invalid wallet addresses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exposes malformed and empty address fixtures', () => {
    expect(MALFORMED_PROFILE_ADDRESS).toBeDefined();
    expect(EMPTY_PROFILE_ADDRESS).toBe('');
    expect(INVALID_PROFILE_ADDRESSES.length).toBeGreaterThanOrEqual(2);
  });

  it.each(INVALID_PROFILE_ADDRESSES.map((addr) => [addr || '<empty>', addr]))(
    'renders a useful error state and never calls the contract for address %s',
    async (_label, address) => {
      render(<ProfileClient address={address} />);

      // A useful error state should be shown to the user.
      const errorState = await screen.findByRole('alert');
      expect(errorState).toBeInTheDocument();
      expect(errorState).toHaveTextContent(/invalid|not valid|address/i);

      // The contract/indexer client must never be called for invalid input.
      assertNoContractCalls();

      // A back/return link should be present so the user can recover.
      const backLink = screen.getByRole('link', { name: /back|return|home/i });
      expect(backLink).toBeInTheDocument();
      expect(backLink).toHaveAttribute('href');
    }
  );

  it('does not call the contract for a malformed address', async () => {
    render(<ProfileClient address={MALFORMED_PROFILE_ADDRESS} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    assertNoContractCalls();
    expect(screen.getByRole('link', { name: /back|return|home/i })).toBeInTheDocument();
  });

  it('does not call the contract for an empty address', async () => {
    render(<ProfileClient address={EMPTY_PROFILE_ADDRESS} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    assertNoContractCalls();
    expect(screen.getByRole('link', { name: /back|return|home/i })).toBeInTheDocument();
  });
});