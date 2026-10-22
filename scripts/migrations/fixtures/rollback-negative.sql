-- Negative fixture: no rollback annotation.
-- This file is a fixture for check-rollback-annotation.sh, NOT a real migration.
-- It intentionally lacks the required `-- rollback:` comment.

CREATE TABLE "fixture_negative" (
  "id" SERIAL PRIMARY KEY,
  "label" TEXT NOT NULL DEFAULT ''
);

-- note: this comment contains the word rollback but does not match the required prefix
