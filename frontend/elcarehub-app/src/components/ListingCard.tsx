// ─────────────────────────────────────────────────────────────
// components/ListingCard.tsx
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { Listing, stroopsToXlm } from "@/lib/contract";
import { ArtworkMetadata, fetchMetadata, getGatewayUrls } from "@/lib/ipfs";
import { useWalletContext } from "@/context/WalletContext";
import { useBuyArtwork } from "@/hooks/useMarketplace";
import { ShoppingCart, User, Calendar, Tag, ShieldAlert, Clock, Hourglass } from "lucide-react";
import { GuardButton } from "./WalletGuard";
import posthog from "posthog-js";
import { CheckoutModal } from "./CheckoutModal";

interface ListingCardProps {
  listing: Listing;
  onPurchased?: () => void;
}

const STATUS_BADGE: Record<string, string> = {
  Active: "bg-green-100 text-green-700",
  Sold: "bg-gray-100 text-gray-500",
  Cancelled: "bg-red-100 text-red-600",
};

export function ListingCard({ listing, onPurchased }: ListingCardProps) {
  const { publicKey, status } = useWalletContext();
  const { buy, isBuying, error: buyError } = useBuyArtwork(publicKey);

  const [metadata, setMetadata] = useState<ArtworkMetadata | null>(null);
  const [gatewayIndex, setGatewayIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showCheckout, setShowCheckout] = useState(false);
  const [purchaseSuccess, setPurchaseSuccess] = useState(false);

  // Resolve metadata from IPFS on mount.
  useEffect(() => {
    setIsLoading(true);
    fetchMetadata(listing.metadata_cid)
      .then(setMetadata)
      .catch(() => setMetadata(null))
      .finally(() => setIsLoading(false));
  }, [listing.metadata_cid]);

  // Reset gateway index when metadata changes (new image to load).
  useEffect(() => {
    setGatewayIndex(0);
  }, [metadata?.image]);

  const imageUrls: string[] | null = metadata?.image
    ? getGatewayUrls(metadata.image)
    : null;

  const currentImageUrl = imageUrls?.[gatewayIndex] ?? null;
  const allGatewaysExhausted = imageUrls !== null && gatewayIndex >= imageUrls.length;

  const isOwn = publicKey === listing.artist;
  const isExpired = listing.status === "Cancelled" && !!listing.expires_at && listing.expires_at < Date.now() / 1000;

  // Countdown for active listings with an expiry deadline
  const [countdown, setCountdown] = useState<string | null>(null);
  useEffect(() => {
    if (listing.status !== "Active" || !listing.expires_at) {
      setCountdown(null);
      return;
    }
    const update = () => {
      const now = Date.now() / 1000;
      if (now >= listing.expires_at!) {
        setCountdown("Expired");
        return;
      }
      const remaining = Math.floor(listing.expires_at! - now);
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      const s = remaining % 60;
      setCountdown(
        h > 0
          ? `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`
          : `${m}m ${String(s).padStart(2, "0")}s`
      );
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [listing.status, listing.expires_at]);

  const handleBuy = async () => {
    return await buy(listing.listing_id);
  };

  return (
    <>
      <CheckoutModal 
        isOpen={showCheckout} 
        onClose={() => setShowCheckout(false)} 
        listing={listing} 
        onCryptoPurchase={handleBuy}
        onPurchased={() => {
          setPurchaseSuccess(true);
          onPurchased?.();
        }}
        isBuyingCrypto={isBuying}
      />
      {purchaseSuccess && (
        <p
          data-testid="purchase-success"
          role="status"
          className="sr-only"
        >
          Purchase successful
        </p>
      )}
      <div
        data-testid={`listing-card-${listing.listing_id}`}
        className="group flex flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm hover:shadow-md transition-shadow"
      >
      {/* Image */}
      <Link href={`/listings/${listing.listing_id}`}>
        <div className="relative aspect-square overflow-hidden bg-brand-50">
          {isLoading ? (
            <div className="flex h-full w-full items-center justify-center bg-gray-100 animate-pulse" aria-label="Loading artwork" data-testid="artwork-loading">
              <span className="sr-only">Loading artwork...</span>
            </div>
          ) : currentImageUrl && !allGatewaysExhausted ? (
            <Image
              key={currentImageUrl}
              src={currentImageUrl}
              alt={
                metadata?.isDecorativeImage
                  ? ""
                  : (metadata?.altText ?? metadata?.title ?? `Listing #${listing.listing_id}`)
              }
              fill
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              onError={() => setGatewayIndex((i) => i + 1)}
              unoptimized
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center bg-gray-50 text-gray-400" aria-label="Artwork missing" data-testid="artwork-missing">
              <span className="text-4xl mb-2">🖼️</span>
              <span className="text-xs font-medium uppercase tracking-wider">No Artwork</span>
            </div>
          )}

          {/* Status badge */}
          <span
            className={`absolute right-3 top-3 rounded-full px-2.5 py-0.5 text-xs font-semibold ${isExpired ? "bg-orange-100 text-orange-600" : STATUS_BADGE[listing.status] ?? "bg-gray-100 text-gray-500"}`}
          >
            {isExpired ? "Expired" : listing.status}
          </span>

          {/* Countdown badge for active listings with an expiry */}
          {countdown && listing.status === "Active" && (
            <span className="absolute left-3 top-3 flex items-center gap-1 rounded-full bg-midnight-900/80 backdrop-blur-sm px-2.5 py-0.5 text-[10px] font-bold text-white/80 uppercase tracking-wider">
              <Clock size={10} />
              {countdown}
            </span>
          )}
        </div>
      </Link>

      {/* Info */}
      <div className="flex flex-1 flex-col p-4">
        <Link href={`/listings/${listing.listing_id}`}>
          <h3 className="truncate text-base font-semibold text-gray-900 hover:text-brand-600 transition-colors">
            {metadata?.title ?? `Artwork #${listing.listing_id}`}
          </h3>
        </Link>

        {metadata?.description && (
          <p className="mt-1 line-clamp-2 text-sm text-gray-500">
            {metadata.description}
          </p>
        )}

        <div className="mt-3 space-y-1 text-xs text-gray-400">
          <div className="flex items-center gap-1.5">
            <User size={12} />
            <span className="truncate font-mono">
              {listing.artist.slice(0, 8)}…{listing.artist.slice(-4)}
            </span>
          </div>
          {metadata?.creator && (
            <div className="flex items-center gap-1.5">
              <User size={12} />
              <span className="truncate">{metadata.creator}</span>
            </div>
          )}
          {metadata?.year && (
            <div className="flex items-center gap-1.5">
              <Calendar size={12} />
              <span>{metadata.year}</span>
            </div>
          )}
          {metadata?.license && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider opacity-70">
                {metadata.license}
              </span>
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-brand-600">
            <Tag size={14} />
            <span className="text-lg font-bold">
              {stroopsToXlm(listing.price)} XLM
            </span>
          </div>

          {listing.status === "Active" && (
            <GuardButton
              data-testid="buy-now-button"
              onAction={() => setShowCheckout(true)}
              disabled={isBuying || isOwn}
              actionName="To purchase this artwork"
              title={isOwn ? "You cannot buy your own listing" : undefined}
              className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-bold text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 transition-all shadow-md shadow-brand-500/20 active:scale-95"
            >
              <ShoppingCart size={14} />
              {isBuying ? "Buying…" : isOwn ? "Yours" : "Buy Now"}
            </GuardButton>
          )}
        </div>


        {buyError && (
          <p className="mt-2 text-xs text-red-500">{buyError}</p>
        )}

        {/* Revoked-artist banner — shown when listing is Cancelled and artist
            was revoked; collectors see why the item is no longer purchasable */}
        {listing.status === "Cancelled" && !isExpired && (
          <div
            className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2"
            role="alert"
            data-testid="revoked-artist-banner"
          >
            <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <p className="text-[11px] leading-snug text-amber-400">
              This listing was cancelled because the artist&apos;s account has
              been suspended by the platform.
            </p>
          </div>
        )}
        {isExpired && (
          <div
            className="mt-3 flex items-start gap-2 rounded-xl border border-orange-500/20 bg-orange-500/10 px-3 py-2"
            role="alert"
            data-testid="expired-listing-banner"
          >
            <Hourglass size={14} className="mt-0.5 shrink-0 text-orange-400" />
            <p className="text-[11px] leading-snug text-orange-400">
              This listing has expired and is no longer available for purchase.
            </p>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
