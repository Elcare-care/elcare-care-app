import { Metadata } from 'next'
import ProfileClient from './ProfileClient'
import { fetchRoyaltyStats, fetchArtistListings } from '@/lib/indexer'
import { config } from '@/lib/config'

interface ProfilePageProps {
  params: Promise<{
    address: string
  }>
}

export async function generateMetadata({ params }: ProfilePageProps): Promise<Metadata> {
  const { address } = await params
  const baseUrl = config.baseUrl
  
  try {
    // Fetch artist data for metadata
    const [royaltyStats, artistListings] = await Promise.all([
      fetchRoyaltyStats(address),
      fetchArtistListings(address)
    ])

    const totalVolume = royaltyStats?.totalEarned || '0'
    const artworkCount = artistListings?.length || 0
    const totalSales = royaltyStats?.payoutCount || 0

    const title = `African Artist Profile | ${address.slice(0, 6)}…${address.slice(-4)} | Elcare-Hub`
    const description = `Discover African digital art by ${address.slice(0, 6)}…${address.slice(-4)}. ${artworkCount} artworks created, ${totalSales} artworks sold, ${totalVolume} XLM in total volume. Explore unique NFT collections on the Stellar blockchain.`

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: 'profile',
        url: `${baseUrl}/profile/${address}`,
        images: [
          {
            url: `${baseUrl}/api/og/artist/${address}`,
            width: 1200,
            height: 630,
            alt: `Artist Profile - ${address.slice(0, 6)}…${address.slice(-4)}`,
          },
        ],
        siteName: 'Elcare-Hub - African Art Marketplace',
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [`${baseUrl}/api/og/artist/${address}`],
        creator: '@Elcare-Hub',
        site: '@Elcare-Hub',
      },
      alternates: {
        canonical: `${baseUrl}/profile/${address}`,
      },
      keywords: [
        'African art',
        'NFT',
        'Stellar blockchain',
        'Digital art',
        'Artist profile',
        address.slice(0, 6),
        address.slice(-4),
        'Crypto art',
        'Blockchain art',
      ],
      authors: [{ name: `${address.slice(0, 6)}…${address.slice(-4)}` }],
      category: 'art',
    }
  } catch (error) {
    console.error('Failed to generate metadata for artist profile:', error)
    
    return {
      title: `Artist Profile | ${address.slice(0, 6)}…${address.slice(-4)} | Elcare-Hub`,
      description: `Discover African digital art on the Stellar blockchain. Explore unique NFT collections and support African artists.`,
    }
  }
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { address } = await params
  return <ProfileClient address={address} />
}
