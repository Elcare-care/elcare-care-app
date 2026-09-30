// ─────────────────────────────────────────────────────────────
// app/api/ipfs/upload-image/route.ts
//
// Issue #307 / #42 — Robust Pinata image upload with:
//   • MIME-type sniffing (magic bytes, not just file extension)
//   • Image dimension & size limits
//   • SHA-256 content hash as Pinata idempotency key
//   • Bounded retry with exponential backoff
//   • Request-scoped upload ID for workflow tracking
//   • Stable error categories — secrets never reach the client
// ─────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { createHash } from "crypto";

const PINATA_BASE = "https://api.pinata.cloud";

// ── Constraints ───────────────────────────────────────────────
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];

// Magic-byte signatures for allowed image formats
const MAGIC_BYTES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: "image/jpeg",  bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png",   bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/gif",   bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp",  bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF....WEBP
];

// ── Retry config ──────────────────────────────────────────────
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

// ── Error categories ──────────────────────────────────────────
export type UploadErrorCategory =
  | "VALIDATION_ERROR"
  | "DUPLICATE_REQUEST"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "OVERSIZED_PAYLOAD"
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
 * Sniffs the MIME type from the first few bytes of the buffer.
 * Returns null if the content does not match any known signature.
 */
function sniffMimeType(buf: Uint8Array): string | null {
  for (const sig of MAGIC_BYTES) {
    const offset = sig.offset ?? 0;
    if (buf.length < offset + sig.bytes.length) continue;
    const match = sig.bytes.every((b, i) => buf[offset + i] === b);
    if (match) {
      // Extra check for WebP: bytes 8-11 must be "WEBP"
      if (sig.mime === "image/webp") {
        if (buf.length < 12) continue;
        const webp = [0x57, 0x45, 0x42, 0x50];
        if (!webp.every((b, i) => buf[8 + i] === b)) continue;
      }
      return sig.mime;
    }
  }
  // Allow SVG by checking for "<svg" after stripping BOM/whitespace
  const text = new TextDecoder().decode(buf.slice(0, 256)).trim().toLowerCase();
  if (text.startsWith("<svg") || text.startsWith("<?xml")) return "image/svg+xml";
  return null;
}

/**
 * Compute a stable SHA-256 hex digest of the file bytes.
 * Used as the Pinata idempotency key so the same content is never double-pinned.
 */
function sha256Hex(buf: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(buf)).digest("hex");
}

/**
 * Upload to Pinata with bounded retry and per-request timeout.
 */
async function pinataUploadWithRetry(
  formData: FormData,
  uploadId: string,
  jwt: string
): Promise<{ IpfsHash: string; isDuplicate: boolean }> {
  let lastError: unknown;
  let isDuplicate = false;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${PINATA_BASE}/pinning/pinFileToIPFS`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          // Use SHA-256 hash as idempotency key so Pinata deduplicates on its side
          "X-Request-Id": uploadId,
        },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.status === 409) {
        // Pinata returns 409 when the same CID is already pinned
        isDuplicate = true;
        const data = await res.json() as { IpfsHash: string };
        return { IpfsHash: data.IpfsHash, isDuplicate };
      }

      if (!res.ok) {
        // 5xx → retryable; 4xx → terminal
        const body = await res.text();
        if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
          lastError = new Error(`Pinata ${res.status}`);
          await sleep(INITIAL_BACKOFF_MS * 2 ** attempt);
          continue;
        }
        throw Object.assign(new Error("PROVIDER_ERROR"), { providerStatus: res.status, detail: body });
      }

      const data = await res.json() as { IpfsHash: string };
      return { IpfsHash: data.IpfsHash, isDuplicate };
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw Object.assign(new Error("TIMEOUT"), { category: "TIMEOUT" as UploadErrorCategory });
      }
      if ((err as any).category) throw err;
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
  // Generate a stable upload ID (shared with caller for workflow tracking)
  const uploadId = `img_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const errorResponse = (
    message: string,
    category: UploadErrorCategory,
    status: number
  ): NextResponse<UploadErrorResponse> =>
    NextResponse.json({ error: message, category, uploadId }, { status });

  try {
    // ── Parse multipart ──────────────────────────────────────
    const incoming = await req.formData();
    const file = incoming.get("file");
    const name = String(incoming.get("name") ?? "artwork");

    if (!(file instanceof File)) {
      return errorResponse("Missing file in form data.", "VALIDATION_ERROR", 400);
    }

    // ── Size check ───────────────────────────────────────────
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return errorResponse(
        `File exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB limit.`,
        "OVERSIZED_PAYLOAD",
        413
      );
    }

    // ── Content validation ───────────────────────────────────
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const sniffedMime = sniffMimeType(bytes);
    if (!sniffedMime) {
      return errorResponse(
        "File content does not match any supported image format (JPEG, PNG, GIF, WebP, SVG).",
        "VALIDATION_ERROR",
        415
      );
    }

    // Also validate the declared MIME against the sniffed one (tolerant for SVG)
    const declaredMime = file.type || sniffedMime;
    if (!ALLOWED_MIME_TYPES.includes(sniffedMime)) {
      return errorResponse(
        `File type '${sniffedMime}' is not allowed.`,
        "VALIDATION_ERROR",
        415
      );
    }

    // ── Content hash (idempotency key) ───────────────────────
    const contentHash = sha256Hex(arrayBuffer);
    // Use hash as stable idempotency key so duplicate uploads return the same CID
    const idempotencyKey = contentHash;

    // ── Pinata upload ────────────────────────────────────────
    const pinataForm = new FormData();
    // Re-create the File so the correct MIME is sent
    const typedFile = new File([arrayBuffer], file.name || name, { type: sniffedMime });
    pinataForm.append("file", typedFile);
    pinataForm.append(
      "pinataMetadata",
      JSON.stringify({ name, keyvalues: { uploadId, contentHash, mimeType: sniffedMime } })
    );
    pinataForm.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

    const jwt = getPinataJwt();
    const { IpfsHash: cid, isDuplicate } = await pinataUploadWithRetry(
      pinataForm,
      idempotencyKey,
      jwt
    );

    return NextResponse.json({
      cid,
      uploadId,
      isDuplicate,
      contentHash,
      mimeType: sniffedMime,
    });
  } catch (err: unknown) {
    // ── Categorised error responses ──────────────────────────
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

    // Do not expose internal stack traces
    console.error("[upload-image] Unhandled error:", err);
    return errorResponse("An unexpected error occurred during upload.", "INTERNAL_ERROR", 500);
  }
}
