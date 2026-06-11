// ─────────────────────────────────────────────────────────────
// hooks/usePlaceBid.ts — Place bid hook
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useCallback } from "react";
import { placeBid } from "@/lib/contract";
import { getReadableErrorMessage } from "@/lib/errors";
import { useTransientErrorToast } from "./useTransientErrorToast";

export function usePlaceBid(bidderPublicKey: string | null) {
  const [isBidding, setIsBidding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const bid = useCallback(
    async (auctionId: number, amountXlm: number): Promise<boolean> => {
      if (!bidderPublicKey) {
        setError("Wallet not connected");
        return false;
      }
      setIsBidding(true);
      setError(null);
      try {
        await placeBid(bidderPublicKey, auctionId, amountXlm);
        return true;
      } catch (err: unknown) {
        setError(getReadableErrorMessage(err, "Failed to place bid"));
        return false;
      } finally {
        setIsBidding(false);
      }
    },
    [bidderPublicKey],
  );

  return { bid, isBidding, error };
}
