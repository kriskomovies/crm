-- Indexes for the /api/stats rollups.
--
-- NOTE ON THE COLUMN NAME: this runs BEFORE
-- 20260730001500_rename_creator_to_personality, so at this point the column is
-- still "creatorId". This file previously said "personalityId", which worked on
-- every machine that had already applied its earlier content and failed on
-- every genuinely fresh database with
--
--     ERROR: column "personalityId" does not exist   (SQLSTATE 42703)
--
-- A migration has to describe the schema as it exists at ITS point in the
-- sequence, not as it looks today. The rename migration renames this index
-- along with all the others.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "assignments_accountId_createdAt_idx" ON "assignments"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "people_creatorId_createdAt_idx" ON "people"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sheets_accountId_receivedAt_idx" ON "sheets"("accountId", "receivedAt");
