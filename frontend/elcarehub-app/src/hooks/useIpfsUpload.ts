// ─────────────────────────────────────────────────────────────
// hooks/useIpfsUpload.ts — client orchestration for the artwork
// metadata upload pipeline (Issue #530)
//
// Wraps the existing lib/ipfs.ts upload + verification helpers behind an
// explicit status state machine so UI can:
//   • show distinct progress for each step (image → metadata → verify)
//   • retry from the failed step instead of restarting from scratch
//   • cancel an in-flight upload via AbortController
//   • refuse to report success until the returned CID has been verified
//     to actually resolve to the uploaded content
//
// This hook does not implement any upload/retry/hash logic itself — it only
// sequences calls into lib/ipfs.ts.
// ─────────────────────────────────────────────────────────────

"use client";

import { useCallback, useRef, useState } from "react";
import {
  ArtworkMetadata,
  IpfsUploadResult,
  computeFileHash,
  uploadImageToIPFS,
  uploadMetadataToIPFS,
  verifyImageUpload,
  verifyMetadataUpload,
  validateImageFile,
} from "@/lib/ipfs";

/**
 * Minimal pre-upload structural check for the metadata fields the
 * upload-metadata API route itself requires (title, artist, image URI).
 * Deliberately does not reuse lib/ipfs.ts's validateArtworkMetadata, which
 * additionally enforces accessibility alt-text — a separate per-form concern
 * (issue #68) that not every caller of this pipeline collects yet.
 */
function findMissingRequiredMetadataFields(metadata: ArtworkMetadata): string[] {
  const missing: string[] = [];
  if (!metadata.title?.trim()) missing.push("title");
  if (!metadata.artist?.trim()) missing.push("artist");
  if (!metadata.image?.trim()) missing.push("image");
  return missing;
}

export type IpfsUploadState =
  | "idle"
  | "validating"
  | "uploadingImage"
  | "uploadingMetadata"
  | "verifying"
  | "success"
  | "error";

export type IpfsUploadErrorKind =
  | "validation"
  | "upload"
  | "verification"
  | "cancelled";

export interface IpfsUploadError {
  kind: IpfsUploadErrorKind;
  message: string;
}

/** Everything the caller needs to build the metadata JSON once the image CID is known. */
export type MetadataBuilder = (imageCid: string | null) => ArtworkMetadata;

export interface StartUploadInput {
  /** New image file to upload. Omit when reusing an existing image CID (e.g. edit flows). */
  imageFile?: File;
  /** Existing "ipfs://CID" to reuse when no new image file is provided. */
  existingImageUri?: string;
  buildMetadata: MetadataBuilder;
  /** Base name used for both the image and metadata pin names. */
  name?: string;
}

export interface IpfsUploadResultPair {
  imageCid: string | null;
  metadataCid: string;
  metadata: ArtworkMetadata;
}

const STEP_LABELS: Record<IpfsUploadState, string> = {
  idle: "",
  validating: "Validating file…",
  uploadingImage: "Uploading image to IPFS…",
  uploadingMetadata: "Uploading metadata to IPFS…",
  verifying: "Verifying uploaded content…",
  success: "Upload verified.",
  error: "",
};

/**
 * Orchestrates the artwork upload pipeline: validate → upload image →
 * upload metadata → verify both CIDs resolve to the submitted content.
 *
 * `success` is only reached once verification has passed — callers must
 * gate any on-chain "create/update listing" call on `state === "success"`
 * so a failed or unverified upload can never leave a draft/listing pointing
 * at unusable or mismatched metadata.
 */
export function useIpfsUpload() {
  const [state, setState] = useState<IpfsUploadState>("idle");
  const [error, setError] = useState<IpfsUploadError | null>(null);
  const [imageResult, setImageResult] = useState<IpfsUploadResult | null>(null);
  const [metadataResult, setMetadataResult] = useState<IpfsUploadResult | null>(null);
  const [metadata, setMetadata] = useState<ArtworkMetadata | null>(null);

  // Retained across retries so we can resume from the failed step rather
  // than re-uploading content that already succeeded and verified fine.
  const lastInputRef = useRef<StartUploadInput | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const imageHashRef = useRef<string>("");
  // Populated only once the image has both uploaded AND verified — used to
  // skip re-uploading the image on retry when just the metadata step failed.
  const verifiedImageRef = useRef<{ result: IpfsUploadResult; uri: string } | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    lastInputRef.current = null;
    imageHashRef.current = "";
    verifiedImageRef.current = null;
    setState("idle");
    setError(null);
    setImageResult(null);
    setMetadataResult(null);
    setMetadata(null);
  }, []);

  const cancel = useCallback(() => {
    if (!abortRef.current) return;
    abortRef.current.abort();
    setState("error");
    setError({ kind: "cancelled", message: "Upload cancelled." });
  }, []);

  const run = useCallback(
    async (input: StartUploadInput): Promise<IpfsUploadResultPair | null> => {
      lastInputRef.current = input;
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      try {
        let currentImageResult = verifiedImageRef.current?.result ?? null;
        let imageCidUri: string | null =
          verifiedImageRef.current?.uri ?? input.existingImageUri ?? null;

        if (input.imageFile && !currentImageResult) {
          setState("validating");
          const validation = await validateImageFile(input.imageFile);
          if (!validation.valid) {
            setError({ kind: "validation", message: validation.messages.join(" ") });
            setState("error");
            return null;
          }

          setState("uploadingImage");
          imageHashRef.current = await computeFileHash(input.imageFile);
          currentImageResult = await uploadImageToIPFS(
            input.imageFile,
            input.name,
            signal
          );
          setImageResult(currentImageResult);

          setState("verifying");
          await verifyImageUpload(
            currentImageResult.cid,
            imageHashRef.current,
            signal
          );
          imageCidUri = `ipfs://${currentImageResult.cid}`;
          verifiedImageRef.current = { result: currentImageResult, uri: imageCidUri };
        }

        const builtMetadata = input.buildMetadata(imageCidUri);
        const missingFields = findMissingRequiredMetadataFields(builtMetadata);
        if (missingFields.length > 0) {
          setError({
            kind: "validation",
            message: `Metadata is missing required field(s): ${missingFields.join(", ")}.`,
          });
          setState("error");
          return null;
        }
        setMetadata(builtMetadata);

        setState("uploadingMetadata");
        const metaResult = await uploadMetadataToIPFS(
          builtMetadata,
          input.name,
          signal
        );
        setMetadataResult(metaResult);

        setState("verifying");
        const fetchedMetadata = await verifyMetadataUpload(
          metaResult.cid,
          builtMetadata,
          signal
        );

        // Reflect the actual round-tripped content (what the indexer will
        // read back) rather than the pre-upload object, so the preview
        // shown to the artist matches the verified, indexed result.
        setMetadata(fetchedMetadata);
        setState("success");
        return {
          imageCid: currentImageResult?.cid ?? null,
          metadataCid: metaResult.cid,
          metadata: fetchedMetadata,
        };
      } catch (err: unknown) {
        if (signal.aborted) {
          setError({ kind: "cancelled", message: "Upload cancelled." });
          setState("error");
          return null;
        }
        const isVerification = (err as Error)?.name === "CidVerificationError";
        setError({
          kind: isVerification ? "verification" : "upload",
          message: err instanceof Error ? err.message : "Upload failed.",
        });
        setState("error");
        return null;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    []
  );

  const start = useCallback(
    (input: StartUploadInput) => run(input),
    [run]
  );

  /**
   * Retries from the last failed step. If the image already uploaded and
   * verified successfully, it is not re-uploaded — only the remaining
   * (metadata upload / verification) steps are re-run.
   */
  const retry = useCallback(() => {
    const input = lastInputRef.current;
    if (!input) return Promise.resolve(null);
    return run(input);
  }, [run]);

  return {
    state,
    error,
    progressLabel: STEP_LABELS[state],
    imageResult,
    metadataResult,
    metadata,
    isActive:
      state === "validating" ||
      state === "uploadingImage" ||
      state === "uploadingMetadata" ||
      state === "verifying",
    start,
    retry,
    cancel,
    reset,
  };
}
