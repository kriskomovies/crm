-- An enrolment token: a bootstrap secret a machine presents to POST /v1/enrol,
-- which it trades for its own per-machine key.
--
-- Additive on purpose. The window (enrolOpenUntil) still works, because an
-- already-deployed agent has no field to put a token in and dropping the window
-- would strand every machine in the field. A client that mints a token can then
-- close its window and stop accepting anonymous enrolments.
ALTER TABLE "clients" ADD COLUMN "enrolTokenHash" TEXT;

-- Unique so the lookup is by hash, exactly like apiKeyHash. Postgres allows
-- many NULLs under a unique constraint, so clients without a token are fine.
CREATE UNIQUE INDEX "clients_enrolTokenHash_key" ON "clients"("enrolTokenHash");
