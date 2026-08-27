-- AlterTable
-- #528: escrow/refund tx hashes let the offers inbox link directly to the
-- on-chain escrow deposit and terminal payout/refund transactions.
-- parentOfferId is groundwork for a future counter-offer relationship —
-- always NULL until that flow is built.
ALTER TABLE "Offer" ADD COLUMN "escrowTxHash" TEXT;
ALTER TABLE "Offer" ADD COLUMN "refundTxHash" TEXT;
ALTER TABLE "Offer" ADD COLUMN "parentOfferId" BIGINT;

-- CreateIndex
CREATE INDEX "Offer_parentOfferId_idx" ON "Offer"("parentOfferId");
