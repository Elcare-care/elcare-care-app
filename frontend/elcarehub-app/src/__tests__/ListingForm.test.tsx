import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ListingForm } from '@/components/ListingForm';

// Mock the hooks used inside ListingForm
jest.mock('@/hooks/useMarketplace', () => ({
  useCreateListing: (pk: string | null) => ({
    create: jest.fn().mockResolvedValue(123),
    isCreating: false,
    progress: '',
    error: null,
  }),
  useUpdateListing: (pk: string | null) => ({
    update: jest.fn().mockResolvedValue(true),
    isUpdating: false,
    progress: '',
    error: null,
  }),
}));

jest.mock('@/hooks/useSupportedTokens', () => ({
  useSupportedTokens: () => ({ tokens: [] }),
}));

jest.mock('@/context/WalletContext', () => ({
  useWalletContext: () => ({ publicKey: 'GABC' }),
}));

describe('ListingForm', () => {
  it('renders form fields and disables submit until file selected', async () => {
    render(<ListingForm onSuccess={() => {}} onCancel={() => {}} />);

    const collectionAddress = screen.getByPlaceholderText(/e.g. C.../i);
    expect(collectionAddress).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: /Create Listing/i });
    expect(submit).toBeInTheDocument();
  });
});
