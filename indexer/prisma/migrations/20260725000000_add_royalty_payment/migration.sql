-- CreateTable
-- #201: royalty audit trail — one row per recipient per settled sale,
-- sourced from ROYALTY_PAID contract events. Exactly one of listingId /
-- auctionId is set, mirroring the on-chain event.
CREATE TABLE "RoyaltyPayment" (
    "id" SERIAL NOT NULL,
    "listingId" BIGINT,
    "auctionId" BIGINT,
    "recipient" TEXT NOT NULL,
    "amount" DECIMAL(32,7) NOT NULL,
    "salePrice" DECIMAL(32,7) NOT NULL,
    "ledgerSequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoyaltyPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoyaltyPayment_recipient_idx" ON "RoyaltyPayment"("recipient");

-- CreateIndex
CREATE INDEX "RoyaltyPayment_ledgerSequence_idx" ON "RoyaltyPayment"("ledgerSequence");

-- CreateIndex
CREATE INDEX "RoyaltyPayment_recipient_ledgerSequence_idx" ON "RoyaltyPayment"("recipient", "ledgerSequence");
