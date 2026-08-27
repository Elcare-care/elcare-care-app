// ─────────────────────────────────────────────────────────────
// hooks/usePlaceBid.ts — Place bid hook
// ─────────────────────────────────────────────────────────────

"use client";

import { useCallback } from "react";
import { placeBid } from "@/lib/contract";
import { useTxToast } from "./useTxToast";

export function usePlaceBid(bidderPublicKey: string | null) {
  const { run, isRunning: isBidding, txHash } = useTxToast();

  const bid = useCallback(
    async (auctionId: number, amountXlm: number): Promise<boolean> => {
      if (!bidderPublicKey) return false;
      const result = await run(
        () => placeBid(bidderPublicKey, auctionId, amountXlm),
        { action: "Bid" }
      );
      return result !== null;
    },
    [bidderPublicKey, run],
  );

  // Issue #520: expose the real transaction hash once known so callers can
  // key a provisional/optimistic UI update against it (see useReconciliation).
  return { bid, isBidding, error: null, txHash };
}
