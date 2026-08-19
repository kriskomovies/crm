-- Handles to seed a brand-new account with.
--
-- A fresh Snapchat account has no Quick Add suggestions at all, so the walk has
-- nothing to walk and the ledger has nobody to offer it. It is onboarded by
-- searching people by name instead, which means it needs a list of names -- and
-- these are typed or pasted by the operator, not read off a contact sheet.
--
-- NOT a `people` row, deliberately. Everything in that table carries what the
-- vision model read: a display name, what the avatar presents as, a nationality
-- and a confidence. An imported handle has none of it, and filter() drops a row
-- whose signals are missing, so an import would be swallowed the moment it
-- arrived. This is a pool to draw from, not a ledger entry, and a person only
-- becomes one of those once an account has actually been given them.
CREATE TABLE "onboarding_handles" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "usedByAccountId" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_handles_pkey" PRIMARY KEY ("id")
);

-- One row per handle per client. Re-importing the same file is how an operator
-- tops the list up, and it must not double it.
CREATE UNIQUE INDEX "onboarding_handles_clientId_handle_key"
    ON "onboarding_handles"("clientId", "handle");

-- "what is left to hand out" -- the only read the onboarding claim makes.
CREATE INDEX "onboarding_handles_clientId_usedAt_idx"
    ON "onboarding_handles"("clientId", "usedAt");

ALTER TABLE "onboarding_handles" ADD CONSTRAINT "onboarding_handles_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ON DELETE SET NULL, not CASCADE: an account being deleted must not delete the
-- record that its handle was already spent, or the next account would be handed
-- somebody this client has already added.
ALTER TABLE "onboarding_handles" ADD CONSTRAINT "onboarding_handles_usedByAccountId_fkey"
    FOREIGN KEY ("usedByAccountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- How many people this account has added by search. It is what decides whether
-- an account still needs onboarding, and it is a count rather than a flag so
-- that "half way through" is a state the UI can show rather than infer.
ALTER TABLE "accounts" ADD COLUMN "onboardedCount" INTEGER NOT NULL DEFAULT 0;
