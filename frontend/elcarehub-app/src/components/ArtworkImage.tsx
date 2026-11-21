// ─────────────────────────────────────────────────────────────
// components/ArtworkImage.tsx — Reusable artwork image with fallback
//
// Consistent image rendering across listing, collection, auction, and
// profile cards. Handles loading states, gateway rotation, retry logic,
// and preserves useful alt text per Issue #68.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { ArtworkMetadata, getGatewayUrls } from "@/lib/ipfs";
import { WifiOff, RefreshCw } from "lucide-react";
import { useLocale } from "@/hooks/useLocale";

/** How many times an artwork image will attempt to reload before giving up. */
const DEFAULT_MAX_RETRIES = 2;

export interface ArtworkImageProps {
  /** IPFS metadata containing the image CID and alt text */
  metadata: ArtworkMetadata | null;
  /** Whether metadata is currently being fetched */
  isLoading?: boolean;
  /** Whether metadata fetch failed */
  metadataError?: boolean;
  /** Callback to retry metadata fetch */
  onRetry?: () => void;
  /** Current retry count */
  retryCount?: number;
  /** Maximum retries before giving up */
  maxRetries?: number;
  /** Additional CSS classes for the container */
  className?: string;
  /** Whether to show content advisory overlay */
  showContentAdvisory?: boolean;
  /** Aspect ratio class (default: aspect-square) */
  aspectRatio?: string;
  /** Background color class (default: bg-brand-50) */
  bgColor?: string;
  /** Accessible label prefix for the image link (e.g., "View artwork:") */
  ariaLabelPrefix?: string;
  /** Fallback ID for the artwork (e.g., listing ID, auction ID) */
  fallbackId?: string | number;
  /** CSS class for the image element (e.g., for hover effects) */
  imageClassName?: string;
}

export function ArtworkImage({
  metadata,
  isLoading = false,
  metadataError = false,
  onRetry,
  retryCount = 0,
  maxRetries = DEFAULT_MAX_RETRIES,
  className = "",
  showContentAdvisory = true,
  aspectRatio = "aspect-square",
  bgColor = "bg-brand-50",
  ariaLabelPrefix = "View artwork:",
  fallbackId,
  imageClassName = "",
}: ArtworkImageProps) {
  const { t } = useLocale();
  const [gatewayIndex, setGatewayIndex] = useState(0);

  // Reset gateway index when metadata changes (new image to load)
  useEffect(() => {
    setGatewayIndex(0);
  }, [metadata?.image]);

  const imageUrls: string[] | null = metadata?.image
    ? getGatewayUrls(metadata.image)
    : null;

  const currentImageUrl = imageUrls?.[gatewayIndex] ?? null;
  const allGatewaysExhausted = imageUrls !== null && gatewayIndex >= imageUrls.length;

  const hasRetriesRemaining = retryCount < maxRetries;

  // Loading state
  if (isLoading) {
    const loadingLabel = t("loading") || "Loading artwork";
    return (
      <div
        className={`flex h-full w-full items-center justify-center ${bgColor} animate-pulse ${className}`}
        aria-label={loadingLabel}
        data-testid="artwork-loading"
      >
        <span className="sr-only">{loadingLabel}…</span>
      </div>
    );
  }

  // Recoverable metadata error: offer a retry
  if (metadataError && hasRetriesRemaining && onRetry) {
    const unavailableLabel = "Content unavailable";
    const retryLabel = "Retry";
    return (
      <div
        className={`flex h-full w-full flex-col items-center justify-center gap-3 bg-gray-50 text-gray-400 ${className}`}
        aria-label={unavailableLabel}
        data-testid="artwork-unavailable"
      >
        <WifiOff size={28} />
        <span className="text-xs font-medium">{unavailableLabel}</span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onRetry();
          }}
          className="flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-600 hover:bg-brand-100 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 transition-colors"
          data-testid="artwork-retry-btn"
          aria-label={`${retryLabel}: ${metadata?.title ?? `Artwork #${fallbackId}`}`}
        >
          <RefreshCw size={11} />
          {retryLabel}
        </button>
      </div>
    );
  }

  // Image with gateway rotation
  if (currentImageUrl && !allGatewaysExhausted) {
    const altText = metadata?.isDecorativeImage
      ? ""
      : (metadata?.altText ?? metadata?.title ?? `Artwork #${fallbackId}`);

    return (
      <div className={`relative ${aspectRatio} overflow-hidden ${bgColor} ${className}`}>
        <Image
          key={currentImageUrl}
          src={currentImageUrl}
          alt={altText}
          fill
          className={`object-cover transition-transform duration-300 ${imageClassName}`}
          onError={() => setGatewayIndex((i) => i + 1)}
          unoptimized
          data-testid="artwork-img"
        />

        {/* Content advisory overlay */}
        {showContentAdvisory && metadata?.contentAdvisory && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-200"
            data-testid="content-advisory-overlay"
            aria-live="polite"
          >
            <div className="mx-3 rounded-xl bg-midnight-900/90 px-3 py-2 text-center">
              <p className="text-[10px] font-bold text-amber-400 uppercase tracking-widest mb-1">
                Content Advisory
              </p>
              <p className="text-[11px] text-white/80 leading-snug">
                {metadata.contentAdvisory}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // All gateways exhausted or no image field
  const missingLabel = t("artwork_missing") || "No Artwork";
  return (
    <div
      className={`flex h-full w-full flex-col items-center justify-center bg-gray-50 text-gray-400 ${className}`}
      aria-label={missingLabel}
      data-testid="artwork-missing"
    >
      <span className="text-4xl mb-2">🖼️</span>
      <span className="text-xs font-medium uppercase tracking-wider">{missingLabel}</span>
    </div>
  );
}
