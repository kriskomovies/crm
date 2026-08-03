-- How hard to push an account becomes one setting per client instead of a
-- column on every account.
--
-- The cap protects the Snapchat account from rate-limiting. That threshold is a
-- property of Snapchat and of how old the account is, not of which account it
-- is, so twenty accounts each carrying their own copy of the number meant
-- twenty places to change it and nineteen chances to miss one. It stays a
-- PER-ACCOUNT cap -- each account gets this many per day -- it is only the
-- setting that is shared.
--
-- followPaceSeconds joins it because they are one decision. The server never
-- follows anything; it serves this to the agents, which is what replaces
-- editing follow_pace_seconds in a config file on every emulator box.
ALTER TABLE "clients" ADD COLUMN "dailyCapPerAccount" INTEGER NOT NULL DEFAULT 240;
ALTER TABLE "clients" ADD COLUMN "followPaceSeconds" INTEGER NOT NULL DEFAULT 2;

-- Dropped rather than carried over. Every existing row held the provisioning
-- default, so there is no per-account intent to preserve -- and keeping the
-- column while nothing read it would leave two answers to "what is the cap"
-- with only one of them true.
ALTER TABLE "accounts" DROP COLUMN "dailyCap";
