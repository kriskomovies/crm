-- The rows an agent swiped off its own Quick Add roster.
--
-- Not a state on assignments: refusedHandles is by definition the people with
-- no assignment to this account (or one pointing at a sibling account), and
-- assignments.personId is UNIQUE, so a hide has nowhere to live there.
CREATE TABLE "hides" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "times" INTEGER NOT NULL DEFAULT 1,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hides_pkey" PRIMARY KEY ("id")
);

-- One row per (account, person): a roster that re-rolls serves the same face
-- again, and hiding it twice is normal. `times` counts that; the row does not
-- multiply.
CREATE UNIQUE INDEX "hides_accountId_personId_key" ON "hides"("accountId", "personId");

-- "what has this box hidden today"
CREATE INDEX "hides_accountId_at_idx" ON "hides"("accountId", "at");

ALTER TABLE "hides" ADD CONSTRAINT "hides_accountId_fkey" FOREIGN KEY ("accountId")
    REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hides" ADD CONSTRAINT "hides_personId_fkey" FOREIGN KEY ("personId")
    REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
