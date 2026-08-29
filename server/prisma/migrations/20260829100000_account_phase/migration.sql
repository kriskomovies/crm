-- Where an account is in its life: cleanup -> seeding -> established.
--
-- A bought account arrives carrying the previous owner's friends, conversations
-- and synced contacts, and none of that may be seeded over. "Has this account
-- been wiped" is not a question onboardedCount can answer -- it counts adds --
-- so it gets a field, and the wipe gets a timestamp so a half-finished one is
-- visible rather than merely absent.
CREATE TYPE "AccountPhase" AS ENUM ('cleanup', 'seeding', 'established');

ALTER TABLE "accounts"
  ADD COLUMN "phase" "AccountPhase" NOT NULL DEFAULT 'cleanup',
  ADD COLUMN "cleanedAt" TIMESTAMP(3);

-- EVERY EXISTING ACCOUNT IS ALREADY PAST THIS, and the default must not decide
-- otherwise. An account that has been running for a fortnight, handed 'cleanup',
-- would be told to delete the friends it spent that fortnight earning. Accounts
-- that have added nobody by search yet are put in 'seeding' rather than
-- 'cleanup' for the same reason: nothing here knows whether they were wiped, and
-- guessing "no" is the destructive guess.
UPDATE "accounts"
   SET "phase" = CASE
         WHEN "onboardedCount" >= 50 THEN 'established'::"AccountPhase"
         ELSE 'seeding'::"AccountPhase"
       END,
       "cleanedAt" = now();
