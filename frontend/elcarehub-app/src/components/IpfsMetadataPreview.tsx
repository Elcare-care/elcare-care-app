// ─────────────────────────────────────────────────────────────
// components/IpfsMetadataPreview.tsx — post-upload metadata preview
// (Issue #530)
//
// After a verified upload, re-fetches the metadata JSON from IPFS and
// renders exactly the fields the indexer reads back onto a Listing row
// (title, description, artistName — see indexer/src/poller.ts
// backfillListingMetadata + indexer/prisma/schema.prisma Listing model)
// so the artist can confirm the indexed result matches before finalising.
// ─────────────────────────────────────────────────────────────

"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ImageOff, Loader2 } from "lucide-react";
import { ArtworkMetadata, cidToGatewayUrl, fetchMetadata } from "@/lib/ipfs";

interface IpfsMetadataPreviewProps {
  /** Metadata CID (raw or "ipfs://CID") returned from a completed, verified upload. */
  cid: string;
  /** Optional: skip the re-fetch and render this metadata directly (e.g. already verified in the hook). */
  metadata?: ArtworkMetadata | null;
}

/** Fields the indexer actually persists onto the Listing row from IPFS metadata. */
const REQUIRED_INDEXED_FIELDS: Array<keyof ArtworkMetadata> = [
  "title",
  "description",
  "artist",
];

export function IpfsMetadataPreview({ cid, metadata: providedMetadata }: IpfsMetadataPreviewProps) {
  const [metadata, setMetadata] = useState<ArtworkMetadata | null>(providedMetadata ?? null);
  const [isLoading, setIsLoading] = useState(!providedMetadata);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (providedMetadata) {
      setMetadata(providedMetadata);
      setIsLoading(false);
      return;
    }
    if (!cid) return;
    let cancelled = false;
    setIsLoading(true);
    setFetchError(null);
    fetchMetadata(cid)
      .then((meta) => {
        if (!cancelled) setMetadata(meta);
      })
      .catch(() => {
        if (!cancelled) {
          setFetchError(
            "Could not load metadata from IPFS to preview. The gateway may be temporarily unavailable."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cid, providedMetadata]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-gray-50 border border-gray-200 px-6 py-4 text-sm text-gray-500">
        <Loader2 size={18} className="animate-spin shrink-0" />
        Loading indexed preview…
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="flex items-start gap-3 rounded-2xl bg-red-50 border border-red-200 px-6 py-4 text-sm text-red-700">
        <AlertTriangle size={18} className="shrink-0 mt-0.5" />
        <span>{fetchError}</span>
      </div>
    );
  }

  if (!metadata) return null;

  const missingFields = REQUIRED_INDEXED_FIELDS.filter(
    (field) => !metadata[field] || String(metadata[field]).trim() === ""
  );
  const schemaValid = missingFields.length === 0;
  const imageUrl = metadata.image ? cidToGatewayUrl(metadata.image) : null;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold uppercase tracking-wider text-gray-700">
          Indexed Preview
        </h4>
        {schemaValid ? (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-green-600">
            <CheckCircle2 size={14} /> Schema valid
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-red-600">
            <AlertTriangle size={14} /> Does not match schema
          </span>
        )}
      </div>

      {!schemaValid && (
        <p className="text-xs text-red-600" role="alert">
          Missing required field{missingFields.length > 1 ? "s" : ""} the indexer
          needs: {missingFields.join(", ")}. This metadata will not be
          searchable/discoverable once indexed.
        </p>
      )}

      <div className="flex gap-4">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-gray-100 flex items-center justify-center">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt={metadata.altText || metadata.title || "Artwork preview"} className="h-full w-full object-cover" />
          ) : (
            <ImageOff size={24} className="text-gray-300" />
          )}
        </div>
        <dl className="flex-1 min-w-0 space-y-1.5 text-sm">
          <div>
            <dt className="text-xs font-semibold text-gray-400 uppercase">Title</dt>
            <dd className={`truncate ${metadata.title ? "text-gray-900" : "text-red-500 italic"}`}>
              {metadata.title || "(missing)"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-gray-400 uppercase">Description</dt>
            <dd className={`line-clamp-2 ${metadata.description ? "text-gray-700" : "text-gray-400 italic"}`}>
              {metadata.description || "(none)"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-gray-400 uppercase">Artist</dt>
            <dd className={metadata.artist ? "text-gray-900" : "text-red-500 italic"}>
              {metadata.artist || "(missing)"}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
