-- The operators' own inventory: proxies bought for the emulator fleet, and
-- Snapchat accounts waiting to be installed on one.
--
-- STOCK, NOT WORKFLOW. Nothing the software does ever reads either table -- no
-- /v1 endpoint serves them, no claim or seed touches them, and no agent is told
-- they exist. They are here because the CRM is the one place every operator
-- already looks, and the alternative was a text file on someone's desktop.
--
-- Credentials in both tables are stored readable, unlike every key in this
-- schema, because they exist to be typed into a device by a human. A hash
-- cannot be typed.
CREATE TABLE "proxies" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'http',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    -- Empty string, not NULL, when the proxy is unauthenticated: the unique
    -- index below is what makes re-pasting a seller's list free, and Postgres
    -- treats NULLs as distinct, so a nullable column there would let the same
    -- credential-less proxy in twice.
    "username" TEXT NOT NULL DEFAULT '',
    "password" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proxies_pkey" PRIMARY KEY ("id")
);

-- Same endpoint, same user = same proxy. Two rows may share host:port under
-- different usernames -- sellers hand out one endpoint per credential.
CREATE UNIQUE INDEX "proxies_clientId_host_port_username_key"
    ON "proxies"("clientId", "host", "port", "username");

ALTER TABLE "proxies" ADD CONSTRAINT "proxies_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOT the accounts table. That is an account the software works; a row here is
-- a credential pair the operators own, and the two are never linked.
CREATE TABLE "stock_accounts" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "proxyId" TEXT,
    "deployedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_accounts_pkey" PRIMARY KEY ("id")
);

-- Re-pasting a seller's file is how the list is topped up; it must not double it.
CREATE UNIQUE INDEX "stock_accounts_clientId_username_key"
    ON "stock_accounts"("clientId", "username");

-- "how loaded is each proxy" -- the read the even-spread picker makes.
CREATE INDEX "stock_accounts_proxyId_idx" ON "stock_accounts"("proxyId");

ALTER TABLE "stock_accounts" ADD CONSTRAINT "stock_accounts_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ON DELETE SET NULL, not CASCADE: an account outlives its proxy and shows as
-- unassigned rather than vanishing with it -- the credential still exists and
-- still cost money, whatever became of the proxy it was going to sit behind.
ALTER TABLE "stock_accounts" ADD CONSTRAINT "stock_accounts_proxyId_fkey"
    FOREIGN KEY ("proxyId") REFERENCES "proxies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
