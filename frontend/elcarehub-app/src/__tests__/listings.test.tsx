import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import ListingDetailPage from '@/app/listings/[id]/page'

// Mock the dependencies
jest.mock('@/context/WalletContext', () => ({
  useWalletContext: () => ({ publicKey: null }),
}))

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: '9999' }), // Invalid ID
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('@/lib/contract', () => ({
  getListing: jest.fn(() => Promise.reject(new Error('Not found'))),
  getAuction: jest.fn(() => Promise.reject(new Error('Not found'))),
  stroopsToXlm: (s: any) => '0',
}))

jest.mock('@/hooks/useMarketplace', () => ({
  useBuyArtwork: () => ({ buy: jest.fn(), isBuying: false, error: null }),
}))

jest.mock('@/hooks/usePlaceBid', () => ({
  usePlaceBid: () => ({ bid: jest.fn(), isBidding: false, error: null }),
}))

jest.mock('@/hooks/useOffers', () => ({
  useListingOffers: () => ({ offers: [], isLoading: false, refresh: jest.fn() }),
  useMakeOffer: () => ({ make: jest.fn(), isOffering: false, error: null }),
}))

jest.mock('@/hooks/useUserActivity', () => ({
  useListingActivity: () => ({ activities: [], isLoading: false }),
}))

describe('Regression Test: Invalid Listing IDs', () => {
  it('renders Artwork Not Found state for invalid IDs', async () => {
    render(<ListingDetailPage params={{ id: '1' }} />)

    // Wait for the async loading to finish and show error
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Artwork Not Found/i })).toBeInTheDocument()
    })

    expect(screen.getByRole('heading', { name: /Artwork Not Found/i })).toBeInTheDocument()
    expect(screen.getByText(/Artwork not found/i, { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Return to Marketplace/i })).toBeInTheDocument()
  })
})
