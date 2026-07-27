// ─────────────────────────────────────────────────────────────
// lib/ipfs.ts — IPFS upload helpers via Pinata REST API
//
// Issue #307 / #42 enhancements:
//   • Returns uploadId and contentHash from routes for workflow tracking
//   • isDuplicate flag surfaces idempotency information to callers
//   • Preserves gateway fallback + metadata fetch behaviour
// ─────────────────────────────────────────────────────────────
//
// Artwork metadata schema (stored on IPFS):
// {
//   "title":       "…",
//   "description": "…",
//   "artist":      "…",
//   "image":       "ipfs://CID",
//   "year":        "2024",
//   "category":    "…"
// }
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import { config } from "./config";

/** Artwork metadata stored on IPFS */
export interface ArtworkMetadata {
  title: string;
  description: string;
  artist: string;
  /** Must be in the form "ipfs://CID" */
  image: string;
  year: string;
  category: string;
}

/** Result of any IPFS upload (enriched with idempotency info) */
export interface IpfsUploadResult {
  cid: string;
  url: string;
  /** Server-assigned upload ID for workflow/reconciliation tracking */
  uploadId: string;
  /** SHA-256 hex digest of the uploaded content */
  contentHash: string;
  /**
   * True when Pinata already had this exact content pinned.
   * The same CID is returned — no duplicate pin is created.
   */
  isDuplicate: boolean;
}

// ── Upload a File (image) ─────────────────────────────────────

/**
 * Uploads an artwork image to IPFS via Pinata.
 * Validates file size and MIME type server-side before pinning.
 * Returns a stable CID even on retried/duplicate requests.
 */
export async function uploadImageToIPFS(
  file: File,
  name?: string
): Promise<IpfsUploadResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("name", name ?? file.name);

  const res = await axios.post<{
    cid: string;
    uploadId: string;
    contentHash: string;
    isDuplicate: boolean;
    mimeType: string;
  }>("/api/ipfs/upload-image", formData, {
    maxBodyLength: Infinity,
  });

  const { cid, uploadId, contentHash, isDuplicate } = res.data;
  return {
    cid,
    url: `${config.pinataGateway}/ipfs/${cid}`,
    uploadId,
    contentHash,
    isDuplicate,
  };
}

// ── Upload JSON metadata ──────────────────────────────────────

/**
 * Uploads artwork metadata JSON to IPFS via Pinata.
 * Validates the metadata schema server-side before pinning.
 * Returns a stable CID even on retried/duplicate requests.
 */
export async function uploadMetadataToIPFS(
  metadata: ArtworkMetadata,
  name?: string
): Promise<IpfsUploadResult> {
  const res = await axios.post<{
    cid: string;
    uploadId: string;
    contentHash: string;
    isDuplicate: boolean;
  }>("/api/ipfs/upload-metadata", {
    metadata,
    name: name ?? `${metadata.title}-metadata.json`,
  });

  const { cid, uploadId, contentHash, isDuplicate } = res.data;
  return {
    cid,
    url: `${config.pinataGateway}/ipfs/${cid}`,
    uploadId,
    contentHash,
    isDuplicate,
  };
}

// ── Public fallback IPFS gateways ──────────────────────────────

export const DEFAULT_FALLBACK_GATEWAYS = [
  "https://ipfs.io",
  "https://cloudflare-ipfs.com",
  "https://dweb.link",
];

/** Normalizes an IPFS URI to a clean CID. Strips `ipfs://` prefix. Passes full HTTP URLs through unchanged. */
export function normalizeIpfsUri(uri: string): string {
  if (uri.startsWith("http")) return uri;
  return uri.replace("ipfs://", "").trim();
}

/**
 * Returns an ordered list of gateway URLs for a given CID.
 * The configured primary gateway comes first, followed by public fallbacks.
 * Deduplicates gateways so the same URL is never tried twice.
 */
export function getGatewayUrls(
  cid: string,
  primaryGateway?: string
): string[] {
  const clean = normalizeIpfsUri(cid);
  if (clean.startsWith("http")) return [clean];

  const primary = primaryGateway ?? config.pinataGateway;
  const seen = new Set<string>();
  return [primary, ...DEFAULT_FALLBACK_GATEWAYS]
    .filter((gw) => {
      if (seen.has(gw)) return false;
      seen.add(gw);
      return true;
    })
    .map((gw) => `${gw.replace(/\/$/, "")}/ipfs/${clean}`);
}

// ── Fetch metadata ────────────────────────────────────────────

/**
 * Fetches and parses artwork metadata JSON from IPFS.
 * `cid` can be a raw CID string or an "ipfs://CID" URI.
 * Tries the primary gateway first, then falls back to public gateways.
 */
export async function fetchMetadata(cid?: string): Promise<ArtworkMetadata> {
  if (!cid) {
    return {
      title: "Unknown Artwork",
      description: "",
      artist: "Unknown",
      image: "",
      year: "",
      category: "",
    };
  }
  const cleanCid = normalizeIpfsUri(cid);
  const urls = getGatewayUrls(cleanCid);
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await axios.get<ArtworkMetadata>(url);
      return res.data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// ── Utility ───────────────────────────────────────────────────

/** Converts a raw CID string or an IPFS URI to an IPFS gateway URL for image display. Handles full URLs gracefully. */
export function cidToGatewayUrl(cid: string): string {
  return getGatewayUrls(cid)[0];
}
