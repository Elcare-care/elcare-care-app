-- AlterTable
-- #200: optional offer expiry so the API/frontend can show countdown timers
-- and filter expired offers. Null = the offer never expires.
ALTER TABLE "Offer" ADD COLUMN "expiresAt" BIGINT;
