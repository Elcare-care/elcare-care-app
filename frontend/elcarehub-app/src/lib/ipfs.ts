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
  // Issue #68: Inclusive artwork metadata and alt-text requirements
  /**
   * Meaningful alt text describing the artwork for screen-reader users.
   * Required unless isDecorativeImage is true.
   * Should describe content, not merely repeat the title.
   */
  altText?: string;
  /**
   * Set true only when the image is purely decorative and conveys no
   * information. When true, the rendered <img> uses alt="" and no altText
   * is required.
   */
  isDecorativeImage?: boolean;
  /** Human-readable creator name; may differ from the artist's wallet address. */
  creator?: string;
  /** Material and technique, e.g. "Oil on canvas", "Digital illustration". */
  medium?: string;
  /** Physical or digital dimensions, e.g. "60×80 cm", "4096×4096 px". */
  dimensions?: string;
  /**
   * Cultural, geographic, or historical context that helps viewers understand
   * the work's origin and significance. Creators should describe this
   * respectfully and accurately, using terms the originating community uses.
   */
  culturalContext?: string;
  /**
   * Attribution or credit for referenced source material.
   * Required when the work builds on or depicts existing cultural property.
   */
  attribution?: string;
  /** License under which the work is released, e.g. "CC BY-SA 4.0", "All Rights Reserved". */
  license?: string;
  /** Optional content advisory describing potentially sensitive subject matter. */
  contentAdvisory?: string;
}

// ── Metadata validation (Issue #68 + Issue #7) ───────────────────────────────

export type MetadataValidationError =
  | "MISSING_TITLE"
  | "MISSING_ARTIST"
  | "MISSING_ALT_TEXT"
  | "ALT_TEXT_TOO_LONG"
  | "MISSING_IMAGE";

export type ImageValidationError =
  | "UNSUPPORTED_TYPE"
  | "FILE_TOO_LARGE"
  | "FILE_EMPTY"
  | "DIMENSIONS_TOO_SMALL"
  | "DIMENSIONS_TOO_LARGE";

export interface ImageValidationResult {
  valid: boolean;
  errors: ImageValidationError[];
  messages: string[];
}

export interface MetadataValidationResult {
  valid: boolean;
  errors: MetadataValidationError[];
  messages: string[];
}

const ALT_TEXT_MAX_LENGTH = 300;

/** Allowed MIME types for artwork image uploads. */
export const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/** Maximum allowed image file size (20 MB). */
export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

/** Minimum artwork dimension in pixels (each side). */
export const MIN_IMAGE_DIMENSION_PX = 100;

/** Maximum artwork dimension in pixels (each side). */
export const MAX_IMAGE_DIMENSION_PX = 8192;

/**
 * Validates an image File before upload.
 * Checks MIME type, file size, and — when the environment supports
 * createImageBitmap — pixel dimensions.
 *
 * The dimension check is best-effort: it is skipped in environments
 * (Node.js test runners) where createImageBitmap is unavailable.
 */
export async function validateImageFile(
  file: File
): Promise<ImageValidationResult> {
  const errors: ImageValidationError[] = [];
  const messages: string[] = [];

  // 1. MIME type
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    errors.push("UNSUPPORTED_TYPE");
    messages.push(
      `Unsupported image type "${file.type}". Allowed: JPEG, PNG, GIF, WebP, SVG.`
    );
  }

  // 2. File size
  if (file.size === 0) {
    errors.push("FILE_EMPTY");
    messages.push("File is empty.");
  } else if (file.size > MAX_IMAGE_SIZE_BYTES) {
    errors.push("FILE_TOO_LARGE");
    messages.push(
      `Image exceeds the 20 MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB given).`
    );
  }

  // 3. Pixel dimensions (browser only; skipped gracefully in tests / SSR)
  if (
    errors.length === 0 &&
    typeof createImageBitmap === "function" &&
    !file.type.includes("svg")
  ) {
    try {
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      if (width < MIN_IMAGE_DIMENSION_PX || height < MIN_IMAGE_DIMENSION_PX) {
        errors.push("DIMENSIONS_TOO_SMALL");
        messages.push(
          `Image dimensions (${width}×${height}px) are below the minimum of ${MIN_IMAGE_DIMENSION_PX}×${MIN_IMAGE_DIMENSION_PX}px.`
        );
      } else if (
        width > MAX_IMAGE_DIMENSION_PX ||
        height > MAX_IMAGE_DIMENSION_PX
      ) {
        errors.push("DIMENSIONS_TOO_LARGE");
        messages.push(
          `Image dimensions (${width}×${height}px) exceed the maximum of ${MAX_IMAGE_DIMENSION_PX}×${MAX_IMAGE_DIMENSION_PX}px.`
        );
      }
    } catch {
      // Dimension check failure is non-fatal; proceed with upload
    }
  }

  return { valid: errors.length === 0, errors, messages };
}

/**
 * Validates artwork metadata before IPFS upload.
 * Enforced both client-side (fast feedback) and server-side (upload route).
 */
export function validateArtworkMetadata(
  metadata: Partial<ArtworkMetadata>
): MetadataValidationResult {
  const errors: MetadataValidationError[] = [];
  const messages: string[] = [];

  if (!metadata.title?.trim()) {
    errors.push("MISSING_TITLE");
    messages.push("Title is required.");
  }
  if (!metadata.artist?.trim()) {
    errors.push("MISSING_ARTIST");
    messages.push("Artist address is required.");
  }
  if (!metadata.image?.trim()) {
    errors.push("MISSING_IMAGE");
    messages.push("Image CID is required.");
  }
  if (!metadata.isDecorativeImage) {
    if (!metadata.altText?.trim()) {
      errors.push("MISSING_ALT_TEXT");
      messages.push(
        "Alt text is required for non-decorative images. Describe what the artwork shows, not just its title."
      );
    } else if (metadata.altText.length > ALT_TEXT_MAX_LENGTH) {
      errors.push("ALT_TEXT_TOO_LONG");
      messages.push(
        `Alt text must be ${ALT_TEXT_MAX_LENGTH} characters or fewer (${metadata.altText.length} given).`
      );
    }
  }

  return { valid: errors.length === 0, errors, messages };
}

/** Computes a SHA-256 hex digest of a File's binary content (browser only). */
export async function computeFileHash(file: File): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) return "";
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
 * Validates file type and size locally before uploading; throws
 * ImageValidationError[] when the file does not meet requirements.
 * Returns a stable CID even on retried/duplicate requests.
 */
export async function uploadImageToIPFS(
  file: File,
  name?: string,
  signal?: AbortSignal
): Promise<IpfsUploadResult> {
  // Client-side validation before any network request
  const validation = await validateImageFile(file);
  if (!validation.valid) {
    const err = new Error(
      `Image validation failed: ${validation.messages.join(" ")}`
    ) as Error & { validationErrors: ImageValidationError[] };
    err.validationErrors = validation.errors;
    throw err;
  }

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
    signal,
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
  name?: string,
  signal?: AbortSignal
): Promise<IpfsUploadResult> {
  const res = await axios.post<{
    cid: string;
    uploadId: string;
    contentHash: string;
    isDuplicate: boolean;
  }>(
    "/api/ipfs/upload-metadata",
    {
      metadata,
      name: name ?? `${metadata.title}-metadata.json`,
    },
    { signal }
  );

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
export async function fetchMetadata(
  cid?: string,
  signal?: AbortSignal
): Promise<ArtworkMetadata> {
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
      const res = await axios.get<ArtworkMetadata>(url, { signal });
      return res.data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// ── CID / content verification (Issue #530) ────────────────────
//
// After a successful Pinata upload, we recompute a hash of the content the
// gateway actually serves back for the returned CID and compare it against a
// hash computed client-side before the upload. This catches a corrupted or
// mismatched pin (wrong CID, gateway serving stale/altered bytes) so that a
// listing is never finalised with a CID that doesn't resolve to the content
// the artist actually submitted.

/** Computes a SHA-256 hex digest of an ArrayBuffer (browser only). */
async function hashBuffer(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) return "";
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deterministically serialises the metadata fields the upload route persists
 * (sorted keys, trimmed strings) so that a hash computed before upload can be
 * compared against a hash computed from the re-fetched JSON, independent of
 * gateway/JSON formatting differences (key order, whitespace).
 */
function canonicalMetadataString(metadata: Partial<ArtworkMetadata>): string {
  const entries = Object.entries(metadata)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]): [string, unknown] => [k, typeof v === "string" ? v.trim() : v])
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

/** Computes a SHA-256 hex digest of the canonicalised metadata object. */
export async function computeMetadataHash(
  metadata: Partial<ArtworkMetadata>
): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) return "";
  const encoded = new TextEncoder().encode(canonicalMetadataString(metadata));
  return hashBuffer(encoded.buffer);
}

export class CidVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CidVerificationError";
  }
}

/**
 * Fetches the raw bytes served for `cid` from the gateway and returns their
 * SHA-256 hex digest. Used to verify an uploaded image round-trips exactly.
 */
export async function fetchContentHash(
  cid: string,
  signal?: AbortSignal
): Promise<string> {
  const urls = getGatewayUrls(cid);
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer", signal });
      return hashBuffer(res.data as ArrayBuffer);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch content for verification");
}

/**
 * Verifies that the image gateway content for `cid` matches the hash of the
 * file that was uploaded. Throws CidVerificationError on mismatch or when the
 * content cannot be fetched.
 */
export async function verifyImageUpload(
  cid: string,
  expectedHash: string,
  signal?: AbortSignal
): Promise<void> {
  if (!expectedHash) return; // hashing unsupported in this environment — skip
  let actualHash: string;
  try {
    actualHash = await fetchContentHash(cid, signal);
  } catch (err) {
    throw new CidVerificationError(
      `Could not verify uploaded image: content at CID ${cid} could not be fetched from any gateway.`
    );
  }
  if (actualHash !== expectedHash) {
    throw new CidVerificationError(
      `Uploaded image content does not match: the CID ${cid} resolves to different bytes than what was uploaded.`
    );
  }
}

/**
 * Verifies that the metadata gateway content for `cid` matches the metadata
 * that was submitted for upload. Throws CidVerificationError on mismatch.
 */
export async function verifyMetadataUpload(
  cid: string,
  submitted: ArtworkMetadata,
  signal?: AbortSignal
): Promise<ArtworkMetadata> {
  let fetched: ArtworkMetadata;
  try {
    fetched = await fetchMetadata(cid, signal);
  } catch (err) {
    throw new CidVerificationError(
      `Could not verify uploaded metadata: content at CID ${cid} could not be fetched from any gateway.`
    );
  }
  const [expectedHash, actualHash] = await Promise.all([
    computeMetadataHash(submitted),
    computeMetadataHash(fetched),
  ]);
  if (expectedHash && actualHash && expectedHash !== actualHash) {
    throw new CidVerificationError(
      `Uploaded metadata content does not match: the CID ${cid} resolves to different metadata than what was submitted.`
    );
  }
  return fetched;
}

// ── Utility ───────────────────────────────────────────────────

/** Converts a raw CID string or an IPFS URI to an IPFS gateway URL for image display. Handles full URLs gracefully. */
export function cidToGatewayUrl(cid: string): string {
  return getGatewayUrls(cid)[0];
}
