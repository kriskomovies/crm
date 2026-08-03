-- A machine can now create its own account under a personality it owns, from
-- the Snapchat handle read off its emulator's profile screen
-- (POST /v1/personalities/:id/accounts). The handle becomes accounts.label,
-- which is the identity and already unique per personality.
--
-- These two carry what the machine saw around it: the display name next to the
-- handle, and the hostname that did the reading. Nothing keys on them -- they
-- exist so an operator looking at an account nobody typed in can tell whose it
-- is and which box is driving it.
--
-- Nullable, and left NULL for every account that predates self-registration.
-- "An operator typed this one in" and "we never recorded it" are the same fact
-- here, so there is nothing to backfill.
ALTER TABLE "accounts" ADD COLUMN "displayName" TEXT;
ALTER TABLE "accounts" ADD COLUMN "machine" TEXT;
