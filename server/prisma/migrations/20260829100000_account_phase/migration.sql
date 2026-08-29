-- Where an account is in its life: a ladder, climbed once and never descended.
--
--   cleanup_contacts -> cleanup_chats -> cleanup_friends -> seeding -> established
--
-- A bought account arrives carrying the previous owner's friends, conversations
-- and synced contacts, and none of that may be seeded over. "Has this account
-- been wiped" is not a question onboardedCount can answer -- it counts adds --
-- so it gets a field of its own.
--
-- The wipe is three rungs rather than one flag because it is the slowest thing
-- that happens to an account: an operator watching a box for twenty minutes
-- needs to tell a cleanup that is progressing from one that is stuck, and a
-- single boolean cannot say which of the three steps it died on. cleanedAt is
-- stamped once, on arrival at seeding, because "when was this account wiped" is
-- one fact even though the wipe has three parts.
CREATE TYPE "AccountPhase" AS ENUM (
  'cleanup_contacts', 'cleanup_chats', 'cleanup_friends', 'seeding', 'established'
);

ALTER TABLE "accounts"
  ADD COLUMN "phase" "AccountPhase" NOT NULL DEFAULT 'cleanup_contacts',
  ADD COLUMN "cleanedAt" TIMESTAMP(3);

-- EVERY EXISTING ACCOUNT IS ALREADY PAST THE WIPE, and the column default must
-- not decide otherwise. An account that has been running for a fortnight, put
-- on a cleanup rung, would be told to delete the friends it spent that
-- fortnight earning -- the single most destructive thing this schema can say.
--
-- Accounts that have added nobody by search yet go to 'seeding' rather than a
-- cleanup rung for the same reason: nothing here knows whether they were wiped,
-- and guessing "no" is the guess that deletes data. cleanedAt is stamped for
-- all of them because they are all being treated as wiped; leaving it null
-- would mean "the wipe never finished", which is the opposite of what this
-- backfill is asserting.
--
-- The 50 is ONBOARD_TARGET (onboarding.service.ts) copied into SQL. It cannot
-- be imported here, and a migration is a historical record rather than live
-- code, so it is pinned to the value that was true when this ran.
UPDATE "accounts"
   SET "phase" = CASE
         WHEN "onboardedCount" >= 50 THEN 'established'::"AccountPhase"
         ELSE 'seeding'::"AccountPhase"
       END,
       "cleanedAt" = now();
