-- Separate caps for an account that is still being onboarded.
--
-- An onboarding account reaches people by typing exact usernames into Snapchat's
-- own search, on the youngest and least trusted account on the box. That is a
-- stronger signal than tapping a suggestion the app offered, so it wants its own
-- ceiling -- and it also has the opposite pressure on it, because it cannot earn
-- anything until it is seeded. One number could not answer both questions, which
-- is what these two are for.
--
-- They REPLACE dailyCapPerAccount and sessionCapPerAccount while the account is
-- onboarding rather than stacking with them (see TargetsService.claim).
-- sessionWindowMinutes is deliberately NOT duplicated: the window is a property
-- of the rotation, not of the account's age.
--
-- Defaults chosen to be safe on an existing fleet: every current client gets 40
-- a day and 10 an hour for its new accounts without anyone setting anything.
ALTER TABLE "clients"
  ADD COLUMN "onboardingDailyCap" INTEGER NOT NULL DEFAULT 40,
  ADD COLUMN "onboardingSessionCap" INTEGER NOT NULL DEFAULT 10;
