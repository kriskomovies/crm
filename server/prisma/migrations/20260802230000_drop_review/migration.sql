-- Drop the review state. The pipeline now forwards a person or drops them;
-- nothing is held for a human.
--
-- Order matters: the rows and the rule action that use the value have to stop
-- using it before the value can leave the type.

-- Held-back assignments are not convertible to anything. A review row meant
-- "no one decided yet", and the decision is now "dropped" -- which in this
-- schema is the absence of an assignment, not a state. The Person rows survive
-- untouched, so a later rule change still replays filter+allocate over them.
DELETE FROM "assignments" WHERE "state" = 'review';

-- A rule that asked for a human now rejects. Not 'forward': every rule written
-- as 'review' was written to mean "do not send this one out yet".
UPDATE "filter_rules" SET "action" = 'reject' WHERE "action" = 'review';

-- The near-duplicate verdict used to live in the review assignment row, where
-- UNIQUE (personId) is what stopped a replay from queueing the twin. With that
-- row gone the verdict has nowhere to survive, and the free replay of
-- filter+allocate after a rule change would queue both readings of one person
-- and follow him twice. So it moves onto the ledger row itself.
ALTER TABLE "people" ADD COLUMN "nearDuplicateOf" TEXT;

-- Postgres cannot remove a value from an enum in place, so the type is rebuilt
-- and the column swapped onto it. The default is dropped first because it is
-- typed against the old enum and blocks the ALTER.
ALTER TYPE "AssignmentState" RENAME TO "AssignmentState_old";
CREATE TYPE "AssignmentState" AS ENUM ('queued', 'handed_out', 'followed', 'failed', 'skipped');
ALTER TABLE "assignments" ALTER COLUMN "state" DROP DEFAULT;
ALTER TABLE "assignments" ALTER COLUMN "state" TYPE "AssignmentState"
  USING ("state"::text::"AssignmentState");
ALTER TABLE "assignments" ALTER COLUMN "state" SET DEFAULT 'queued';
DROP TYPE "AssignmentState_old";
