import { Metadata } from 'next'
import CollectionDetailClient from './CollectionDetailClient'
import { getCollections } from '@/lib/indexer'
import { config } from '@/lib/config'

interface CollectionPageProps {
  params: Promise<{ address: string }>
}

export async function generateMetadata({ params }: CollectionPageProps): Promise<Metadata> {
  const { address } = await params
  const baseUrl = config.baseUrl

  try {
    const { collections } = await getCollections({ creator: address })
    const collection = collections[0]

    if (!collection) {
      return {
        title: `Collection ${address.slice(0, 6)}…${address.slice(-4)} | Elcare-Hub`,
        description: 'Explore this NFT collection on Elcare-Hub, the African art marketplace on Stellar.',
      }
    }

    const name = collection.name || `Collection ${address.slice(0, 6)}…${address.slice(-4)}`
    const creatorShort = `${collection.creator.slice(0, 6)}…${collection.creator.slice(-4)}`
    const title = `${name} | Elcare-Hub Collection`
    const description = `${name} by ${creatorShort} — ${collection.symbol ?? 'NFT'} collection on the Stellar blockchain. Explore and mint unique African digital art.`

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: 'website',
        url: `${baseUrl}/launchpad/collections/${address}`,
        images: [
          {
            url: `${baseUrl}/api/og/artist/${collection.creator}`,
            width: 1200,
            height: 630,
            alt: `${name} collection on Elcare-Hub`,
          },
        ],
        siteName: 'Elcare-Hub - African Art Marketplace',
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [`${baseUrl}/api/og/artist/${collection.creator}`],
        creator: '@Elcare-Hub',
        site: '@Elcare-Hub',
      },
      alternates: {
        canonical: `${baseUrl}/launchpad/collections/${address}`,
      },
      keywords: [
        'African art',
        'NFT collection',
        'Stellar blockchain',
        name,
        collection.symbol ?? '',
        creatorShort,
        'Elcare-Hub',
      ],
    }
  } catch (error) {
    console.error('Failed to generate metadata for collection:', error)
    return {
      title: `Collection | Elcare-Hub`,
      description: 'Explore African NFT collections on the Stellar blockchain.',
    }
  }
}

export default async function CollectionPage({ params }: CollectionPageProps) {
  const { address } = await params
  return <CollectionDetailClient address={address} />
}
