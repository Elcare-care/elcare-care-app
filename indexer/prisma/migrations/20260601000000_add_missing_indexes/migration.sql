CREATE INDEX "MarketplaceEvent_listingId_idx" ON "MarketplaceEvent"("listingId");
CREATE INDEX "MarketplaceEvent_ledgerSequence_idx" ON "MarketplaceEvent"("ledgerSequence");
CREATE INDEX "MarketplaceEvent_listingId_ledgerSequence_idx" ON "MarketplaceEvent"("listingId", "ledgerSequence");
CREATE INDEX "Offer_listingId_idx" ON "Offer"("listingId");
CREATE INDEX "Listing_updatedAtLedger_idx" ON "Listing"("updatedAtLedger");
CREATE INDEX "Auction_updatedAtLedger_idx" ON "Auction"("updatedAtLedger");