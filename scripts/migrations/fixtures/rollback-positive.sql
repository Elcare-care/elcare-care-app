-- Positive fixture: valid rollback annotation present.
-- This file is a fixture for check-rollback-annotation.sh, NOT a real migration.

CREATE TABLE "fixture_positive" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL DEFAULT ''
);

-- rollback: ALTER TABLE "fixture_positive" DROP COLUMN IF EXISTS "name"; DROP TABLE IF EXISTS "fixture_positive";
