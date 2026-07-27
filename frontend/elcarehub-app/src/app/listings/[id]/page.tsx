// ─────────────────────────────────────────────────────────────
// app/listings/[id]/page.tsx — Server component with rich OpenGraph meta
// ─────────────────────────────────────────────────────────────

import { Metadata } from "next";
import ListingClient from "./ListingClient";
import { getListing, getAuction, stroopsToXlm } from "@/lib/contract";
import { fetchMetadata, cidToGatewayUrl } from "@/lib/ipfs";
import { config } from "@/lib/config";

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = params;
  const baseUrl = config.baseUrl || "https://elcarehub.art";

  try {
    let listing = null;
    let auction = null;
    let metadata = null;

    try { listing = await getListing(Number(id)); } catch {}
    try { auction = await getAuction(Number(id)); } catch {}

    const cid = listing?.metadata_cid || auction?.metadata_cid;
    if (cid) {
      try { metadata = await fetchMetadata(cid); } catch {}
    }

    if (!metadata) {
      return {
        title: "Artwork Not Found — Elcare-Hub",
        description: "This artwork could not be found on Elcare-Hub marketplace.",
      };
    }

    const title = metadata.title || `Artwork #${id}`;
    const description =
      metadata.description || "Unique African art on the Stellar blockchain";
    const artist = listing?.artist || auction?.creator || "Unknown Artist";
    const price = listing?.price || auction?.highest_bid || auction?.reserve_price;
    const priceDisplay = price ? `${stroopsToXlm(price)} XLM` : "Price on request";
    const artCategory = (metadata as any).category ?? "African Art";

    // Canonical page URL
    const pageUrl = `${baseUrl}/listings/${id}`;

    // Convert IPFS image to HTTP gateway URL for Open Graph crawlers
    const imageUrl = metadata.image ? cidToGatewayUrl(metadata.image) : null;

    // Rich OG description with artist + price info
    const ogDescription = [
      description.slice(0, 180),
      `Artist: ${artist.slice(0, 12)}…`,
      `Price: ${priceDisplay}`,
      artCategory !== "African Art" ? `Category: ${artCategory}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      title: `${title} — Elcare-Hub`,
      description: `${description.slice(0, 155)} | By ${artist.slice(0, 12)}… | ${priceDisplay}`,

      // ── Open Graph ──────────────────────────────────────────
      openGraph: {
        title,
        description: ogDescription,
        type: "website",
        url: pageUrl,
        siteName: "Elcare-Hub",
        images: imageUrl
          ? [
              {
                url: imageUrl,
                width: 1200,
                height: 1200,
                alt: `${title} — African art on Stellar blockchain`,
              },
            ]
          : [],
      },

      // ── Twitter / X card ─────────────────────────────────────
      twitter: {
        card: "summary_large_image",
        site: "@ElcareHub",
        creator: "@ElcareHub",
        title,
        description: `${description.slice(0, 120)} | ${priceDisplay}`,
        images: imageUrl ? [imageUrl] : [],
      },

      // ── Canonical ───────────────────────────────────────────
      alternates: {
        canonical: pageUrl,
      },

      // ── Other meta ──────────────────────────────────────────
      keywords: [
        "African art",
        "NFT",
        "Stellar blockchain",
        "Elcare-Hub",
        title,
        artCategory,
      ].filter(Boolean),
    };
  } catch (error) {
    console.error("[listing/page.tsx] generateMetadata error:", error);
    return {
      title: "Elcare-Hub — African Art Marketplace",
      description: "Discover unique African art on the Stellar blockchain",
      openGraph: {
        title: "Elcare-Hub — African Art Marketplace",
        description: "Discover unique African art on the Stellar blockchain",
        type: "website",
        siteName: "Elcare-Hub",
      },
    };
  }
}

export default function ListingPage({ params }: PageProps) {
  return <ListingClient id={params.id} />;
}
