// ─────────────────────────────────────────────────────────────
// app/api/ipfs/upload-metadata/route.ts
//
// Issue #307 / #42 — Robust Pinata metadata upload with:
//   • Strict metadata schema validation
//   • SHA-256 content hash for idempotency key
//   • Bounded retry with exponential backoff
//   • Stable error categories — secrets never reach the client
//   • Workflow state tracking via uploadId
// ─────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { createHash } from "crypto";

const PINATA_BASE = "https://api.pinata.cloud";

// ── Constraints ───────────────────────────────────────────────
const TITLE_MAX_LEN = 200;
const DESCRIPTION_MAX_LEN = 2000;
const ARTIST_MAX_LEN = 200;
const YEAR_PATTERN = /^\d{4}$/;
const CID_URI_PATTERN = /^ipfs:\/\/[a-zA-Z0-9]+$/;

// ── Retry config ──────────────────────────────────────────────
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

// ── Types ─────────────────────────────────────────────────────

export interface ArtworkMetadata {
  title: string;
  description: string;
  artist: string;
  /** Must be in the form "ipfs://CID" */
  image: string;
  year: string;
  category: string;
}

export type UploadErrorCategory =
  | "VALIDATION_ERROR"
  | "DUPLICATE_REQUEST"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

interface UploadErrorResponse {
  error: string;
  category: UploadErrorCategory;
  uploadId?: string;
}

// ── Helpers ───────────────────────────────────────────────────

function getPinataJwt(): string {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT not configured");
  return jwt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Validates the artwork metadata object.
 * Returns a human-readable validation error message, or null if valid.
 */
function validateMetadata(m: unknown): string | null {
  if (!m || typeof m !== "object") return "Metadata must be a JSON object.";
  const obj = m as Record<string, unknown>;

  if (typeof obj.title !== "string" || !obj.title.trim())
    return "Field 'title' is required.";
  if (obj.title.length > TITLE_MAX_LEN)
    return `Field 'title' must not exceed ${TITLE_MAX_LEN} characters.`;

  if (typeof obj.description !== "string")
    return "Field 'description' is required.";
  if (obj.description.length > DESCRIPTION_MAX_LEN)
    return `Field 'description' must not exceed ${DESCRIPTION_MAX_LEN} characters.`;

  if (typeof obj.artist !== "string" || !obj.artist.trim())
    return "Field 'artist' is required.";
  if (obj.artist.length > ARTIST_MAX_LEN)
    return `Field 'artist' must not exceed ${ARTIST_MAX_LEN} characters.`;

  if (typeof obj.image !== "string" || !obj.image.trim())
    return "Field 'image' is required and must be an ipfs:// URI.";
  if (!CID_URI_PATTERN.test(obj.image))
    return "Field 'image' must match the pattern 'ipfs://<CID>'.";

  if (typeof obj.year !== "string" || !YEAR_PATTERN.test(obj.year))
    return "Field 'year' must be a 4-digit string (e.g. '2024').";

  if (typeof obj.category !== "string" || !obj.category.trim())
    return "Field 'category' is required.";

  return null;
}

/**
 * Compute SHA-256 hex digest of a deterministically serialised metadata object.
 */
function metadataHash(metadata: ArtworkMetadata): string {
  const canonical = JSON.stringify({
    title: metadata.title.trim(),
    description: metadata.description.trim(),
    artist: metadata.artist.trim(),
    image: metadata.image.trim(),
    year: metadata.year,
    category: metadata.category.trim(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Upload to Pinata with bounded retry and per-request timeout.
 */
async function pinataMetadataUploadWithRetry(
  payload: object,
  idempotencyKey: string,
  uploadId: string,
  jwt: string
): Promise<{ IpfsHash: string; isDuplicate: boolean }> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${PINATA_BASE}/pinning/pinJSONToIPFS`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          "X-Request-Id": idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.status === 409) {
        const data = await res.json() as { IpfsHash: string };
        return { IpfsHash: data.IpfsHash, isDuplicate: true };
      }

      if (!res.ok) {
        const body = await res.text();
        if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
          lastError = new Error(`Pinata ${res.status}`);
          await sleep(INITIAL_BACKOFF_MS * 2 ** attempt);
          continue;
        }
        throw Object.assign(new Error("PROVIDER_ERROR"), { providerStatus: res.status, detail: body });
      }

      const data = await res.json() as { IpfsHash: string };
      return { IpfsHash: data.IpfsHash, isDuplicate: false };
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw Object.assign(new Error("TIMEOUT"), { category: "TIMEOUT" as UploadErrorCategory });
      }
      if ((err as any).category || (err as any).providerStatus) throw err;
      lastError = err;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(INITIAL_BACKOFF_MS * 2 ** attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Upload failed after retries");
}

// ── Route handler ─────────────────────────────────────────────

export async function POST(req: Request) {
  const uploadId = `meta_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const errorResponse = (
    message: string,
    category: UploadErrorCategory,
    status: number
  ): NextResponse<UploadErrorResponse> =>
    NextResponse.json({ error: message, category, uploadId }, { status });

  try {
    const body = await req.json() as { metadata?: unknown; name?: string };

    if (!body.metadata) {
      return errorResponse("Missing 'metadata' payload.", "VALIDATION_ERROR", 400);
    }

    // ── Schema validation ────────────────────────────────────
    const validationError = validateMetadata(body.metadata);
    if (validationError) {
      return errorResponse(validationError, "VALIDATION_ERROR", 422);
    }
    const metadata = body.metadata as ArtworkMetadata;

    // ── Idempotency key from content hash ────────────────────
    const contentHash = metadataHash(metadata);

    const pinataBody = {
      pinataContent: metadata,
      pinataMetadata: {
        name: body.name ?? `${metadata.title}-metadata.json`,
        keyvalues: { uploadId, contentHash },
      },
      pinataOptions: { cidVersion: 1 },
    };

    const jwt = getPinataJwt();
    const { IpfsHash: cid, isDuplicate } = await pinataMetadataUploadWithRetry(
      pinataBody,
      contentHash,
      uploadId,
      jwt
    );

    return NextResponse.json({
      cid,
      uploadId,
      isDuplicate,
      contentHash,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Upload failed";
    const category: UploadErrorCategory =
      (err as any).category === "TIMEOUT" ? "TIMEOUT"
        : msg === "PROVIDER_ERROR" ? "PROVIDER_ERROR"
        : "INTERNAL_ERROR";

    if (category === "TIMEOUT") {
      return errorResponse(
        "The upload service is temporarily unavailable. Please try again in a moment.",
        "TIMEOUT",
        504
      );
    }
    if (category === "PROVIDER_ERROR") {
      return errorResponse(
        "The upload service returned an error. Please retry.",
        "PROVIDER_ERROR",
        502
      );
    }

    console.error("[upload-metadata] Unhandled error:", err);
    return errorResponse("An unexpected error occurred during upload.", "INTERNAL_ERROR", 500);
  }
}
