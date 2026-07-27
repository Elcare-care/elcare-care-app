-- AlterTable
-- #274: expose current/max supply on indexed collections. String-typed to
-- safely hold u64::MAX (the "unlimited" sentinel used by the collection
-- contracts), which overflows a Postgres BigInt (int8).
ALTER TABLE "Collection" ADD COLUMN "maxSupply" TEXT;
ALTER TABLE "Collection" ADD COLUMN "currentSupply" TEXT;
