-- CreateEnum
CREATE TYPE "SheetStatus" AS ENUM ('received', 'extracting', 'extracted', 'partial', 'failed', 'rejected');

-- CreateEnum
CREATE TYPE "Presents" AS ENUM ('man', 'woman', 'ambiguous', 'not_a_person', 'unknown');

-- CreateEnum
CREATE TYPE "AssignmentState" AS ENUM ('queued', 'handed_out', 'followed', 'failed', 'skipped', 'review');

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extractionModel" TEXT NOT NULL DEFAULT 'gemini-3.6-flash',
    "avatarPassEnabled" BOOLEAN NOT NULL DEFAULT false,
    "monthlyBudgetUsd" DECIMAL(10,2) NOT NULL DEFAULT 100,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creators" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dailyCap" INTEGER NOT NULL DEFAULT 50,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheets" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "status" "SheetStatus" NOT NULL DEFAULT 'received',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extractions" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rawReply" JSONB NOT NULL,
    "profilesFound" INTEGER NOT NULL DEFAULT 0,
    "distinctCuesRatio" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "presentsAs" "Presents" NOT NULL DEFAULT 'unknown',
    "avatarPresentsAs" "Presents" NOT NULL DEFAULT 'unknown',
    "namePresentsAs" "Presents" NOT NULL DEFAULT 'unknown',
    "nationality" TEXT,
    "nationalityConf" TEXT,
    "avatarCues" TEXT,
    "firstSeenSheetId" TEXT,
    "timesSeen" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "state" "AssignmentState" NOT NULL DEFAULT 'queued',
    "reason" TEXT,
    "handedOutAt" TIMESTAMP(3),
    "resultAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filter_rules" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "presentsAs" TEXT[],
    "countries" TEXT[],
    "minConfidence" TEXT NOT NULL DEFAULT 'medium',
    "action" TEXT NOT NULL DEFAULT 'forward',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "filter_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overrides" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_apiKeyHash_key" ON "clients"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "creators_clientId_name_key" ON "creators"("clientId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_creatorId_label_key" ON "accounts"("creatorId", "label");

-- CreateIndex
CREATE INDEX "sheets_status_idx" ON "sheets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sheets_accountId_sha256_key" ON "sheets"("accountId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "extractions_sheetId_key" ON "extractions"("sheetId");

-- CreateIndex
CREATE INDEX "people_creatorId_presentsAs_nationality_idx" ON "people"("creatorId", "presentsAs", "nationality");

-- CreateIndex
CREATE UNIQUE INDEX "people_creatorId_handle_key" ON "people"("creatorId", "handle");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_personId_key" ON "assignments"("personId");

-- CreateIndex
CREATE INDEX "assignments_accountId_state_idx" ON "assignments"("accountId", "state");

-- CreateIndex
CREATE INDEX "assignments_accountId_handedOutAt_idx" ON "assignments"("accountId", "handedOutAt");

-- CreateIndex
CREATE UNIQUE INDEX "filter_rules_clientId_position_key" ON "filter_rules"("clientId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "overrides_personId_field_key" ON "overrides"("personId", "field");

-- AddForeignKey
ALTER TABLE "creators" ADD CONSTRAINT "creators_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheets" ADD CONSTRAINT "sheets_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_firstSeenSheetId_fkey" FOREIGN KEY ("firstSeenSheetId") REFERENCES "sheets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_rules" ADD CONSTRAINT "filter_rules_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
