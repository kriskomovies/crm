-- Creator became Personality: a persona identity owning up to ~10 accounts.
--
-- Written as renames rather than a drop-and-recreate because `people` IS the
-- dedupe ledger. Dropping it would discard every handle already claimed, and
-- those rows are the only record of which accounts have already followed whom
-- -- there is no way to rebuild them short of re-running every extraction.

ALTER TABLE "creators" RENAME TO "personalities";
ALTER TABLE "accounts" RENAME COLUMN "creatorId" TO "personalityId";
ALTER TABLE "people" RENAME COLUMN "creatorId" TO "personalityId";

-- Constraint and index names are part of what Prisma diffs the schema against,
-- so they are renamed too; left alone they show up as permanent drift and the
-- next `migrate dev` offers to reset the database to "fix" it.
ALTER TABLE "personalities" RENAME CONSTRAINT "creators_pkey" TO "personalities_pkey";
ALTER TABLE "personalities" RENAME CONSTRAINT "creators_clientId_fkey" TO "personalities_clientId_fkey";
ALTER INDEX "creators_clientId_name_key" RENAME TO "personalities_clientId_name_key";

ALTER TABLE "accounts" RENAME CONSTRAINT "accounts_creatorId_fkey" TO "accounts_personalityId_fkey";
ALTER INDEX "accounts_creatorId_label_key" RENAME TO "accounts_personalityId_label_key";

ALTER TABLE "people" RENAME CONSTRAINT "people_creatorId_fkey" TO "people_personalityId_fkey";
-- The constraint the product is sold on. Composite, not global: two
-- personalities following the same handle is legal and expected.
ALTER INDEX "people_creatorId_handle_key" RENAME TO "people_personalityId_handle_key";
ALTER INDEX "people_creatorId_presentsAs_nationality_idx" RENAME TO "people_personalityId_presentsAs_nationality_idx";

-- CreateEnum
CREATE TYPE "PersonSource" AS ENUM ('extraction', 'manual');

-- AlterTable. Everything already in the ledger arrived via a screenshot.
ALTER TABLE "people" ADD COLUMN "source" "PersonSource" NOT NULL DEFAULT 'extraction';
