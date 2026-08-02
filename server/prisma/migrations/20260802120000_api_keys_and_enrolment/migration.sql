-- Per-machine credentials, so a box can be set up by typing only an address.
--
-- Before this there was exactly one key per client, in clients.apiKeyHash. That
-- key had to be copied onto every emulator machine by hand, could not be
-- revoked for one machine without breaking all of them, and -- because only its
-- hash is stored -- could not be handed back out by the server if it was lost.
--
-- clients.apiKeyHash is deliberately LEFT IN PLACE and still accepted. It is the
-- operator's key, the one Caddy injects for the CRM UI. This table is what
-- enrolment writes to.

CREATE TABLE "api_keys" (
    "id"         TEXT NOT NULL,
    "clientId"   TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "hash"       TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt"  TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- Unique because the guard looks a key up BY hash: two rows sharing one hash
-- would make "which client is this" ambiguous.
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");
CREATE INDEX "api_keys_clientId_idx" ON "api_keys"("clientId");

ALTER TABLE "api_keys"
    ADD CONSTRAINT "api_keys_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The enrolment window. NULL means closed, which is the only safe default:
-- an open window lets anyone who reaches the domain mint a key, so it has to
-- expire on its own rather than rely on someone remembering to switch it off.
ALTER TABLE "clients" ADD COLUMN "enrolOpenUntil" TIMESTAMP(3);
