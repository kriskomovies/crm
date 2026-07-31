-- CreateIndex
CREATE INDEX "assignments_accountId_createdAt_idx" ON "assignments"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "people_personalityId_createdAt_idx" ON "people"("personalityId", "createdAt");

-- CreateIndex
CREATE INDEX "sheets_accountId_receivedAt_idx" ON "sheets"("accountId", "receivedAt");
