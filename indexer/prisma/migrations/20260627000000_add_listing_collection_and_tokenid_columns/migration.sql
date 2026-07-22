-- Corrective migration: the Listing.collection and Listing.nftTokenId columns
-- exist in schema.prisma and are referenced by 20260628000000_add_composite_indexes
-- and by production seed/indexer code paths, but were never created by any prior
-- migration. Add them so `prisma migrate deploy` succeeds against a fresh DB.

-- AlterTable Listing — add the columns the schema.prisma declares.
ALTER TABLE "Listing" ADD COLUMN "collection" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Listing" ADD COLUMN "nftTokenId" BIGINT NOT NULL DEFAULT 0;

-- schema.prisma's Listing model also drops metadataCid and royaltyBps, but the
-- baseline created them NOT NULL. The generated Prisma client cannot supply
-- either value because the columns aren't in the model — relax them so inserts
-- via the public Prisma client don't violate NOT NULL.
ALTER TABLE "Listing" ALTER COLUMN "metadataCid" DROP NOT NULL;
ALTER TABLE "Listing" ALTER COLUMN "royaltyBps" DROP NOT NULL;
