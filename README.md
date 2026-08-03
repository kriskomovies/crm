# crm — follow-target service

Backend and operator UI. Accepts contact-sheet screenshots from client machines,
reads them with a vision model, keeps a per-personality ledger of handles, and
hands each account a metered list of who to follow.

The machines that produce those screenshots and do the following are a separate
project: **snap-automation**. They talk to this one over HTTP and share nothing
else.

## Layout

| | |
|---|---|
| `server/` | NestJS 11 + Prisma + Postgres. The API, the pipeline, the queue worker |
| `web/` | React 19 + Vite operator UI |
| `vlm_eval/` | the measurement harness behind every model, prompt and cost decision. `ground_truth.json` is the scoring key the server's golden-file test asserts against |
`test/` and `pages/` are **not** in the repository. They held the 99-entry
contact sheet, the 99 row crops cut from it and the nine raw captures — faces,
display names and handles of real people, which do not belong in a history that
outlives any decision to delete them. Supply `test/main/all99_3col.png` yourself
for full e2e coverage; the sheet-driven specs skip without it and say so. See
`server/test/sheet-fixture.ts`.

`vlm_eval/` is here rather than with the client because it justifies *this*
side's choices — which model, which prompt, what it costs, what it gets wrong.
`vlm_eval/ROUTING.md` and `APIMART.md` are the evidence.

## The two constraints that are the product

```prisma
Person     @@unique([personalityId, handle])
Assignment @@unique([personId])
```

Scoped per personality and composite **on purpose**. If kris already follows
@john no other kris account is told to, but personality mia may follow @john
independently. A global unique on handle would silently stop every personality
after the first from growing.

## Running it locally

Needs Postgres. There is a dev cluster on `127.0.0.1:5433` (trust auth, db
`snap`); `server/.env` points at it.

```bash
cd server && npm install && npx prisma migrate deploy && npm run build && node dist/main.js
```

```bash
cd web && npm install && npm run dev
```

Without Redis, set `QUEUE_DRIVER=inline` in `server/.env` — extraction then runs
in the API process. It is a development mode: no worker, no retries. The test
suite pins the real queue regardless, so what is covered does not depend on the
machine.

## Tests

```bash
cd server && npx vitest run
```

441 across four projects — 432 on a fresh clone, since the nine sheet-driven
e2e tests skip until you supply the fixture above. `unit` (pure functions),
`int` (real Postgres —
per-personality scoping and the concurrent metered claim), `http` (auth, tenant
isolation, validation), `e2e` (real HTTP through the booted app, real pipeline,
the vision call replayed from recorded output).

## Deploying

```bash
cp .env.example .env    # SITE_ADDRESS, APIMART_API_KEY, OPERATOR_API_KEY, UI_PASSWORD_HASH
docker compose up -d --build
```

DNS must already point at the box or Caddy cannot issue a certificate. Only
80/443 are published; Postgres and MinIO bind loopback.

## Enrolling a machine

`POST /v1/enrol` is the one unauthenticated route — it has to be, it is how a
box with no credential gets one. What limits it is an **enrolment token**: a
bootstrap secret the operator types into the agent next to the server address.

```bash
docker compose exec api node dist/cli/provision.js --client "my agency" --enrol-token
```

Printed once, stored as a hash. The agent sends it as `{ name, token }` and gets
back its own `sk_...` key plus the personalities and accounts it should run, so
its config file holds no identity at all.

The token is **not** a working credential and deliberately cannot be used as
one. It buys exactly one thing: an `ApiKey` row for that single machine. A
shared key pasted onto twenty boxes could not be revoked for one of them, which
is the whole reason `api_keys` exists.

The older path — an operator opening a timed window, no token — still works, and
only because an agent built before the token has no field to send one from. It
is the weaker of the two: while a window is open, **any** anonymous caller that
finds the host can mint a key. Once your machines send a token, close it and
leave it closed:

```bash
curl -XPOST http://<host>/api/enrolment/close -H "Authorization: Bearer <operator key>"
```

A token also names its own client, so several tenants can enrol machines
simultaneously. The window path cannot: it scans every client and refuses
outright when more than one has a window open.

## A machine names its own account

The operator creates **only a personality**. Nobody types an account label
anywhere: the machine reads the Snapchat handle off its emulator's own profile
screen and registers it.

```
POST /v1/personalities/:id/accounts   { "handle": "iraxcvp" }
```

Authenticated by the machine's own client key, like every other `/v1` call. It
is deliberately **not** the operator's `POST /api/personalities/:id/accounts`,
which still exists and still refuses a label it already has — an operator typing
a name twice has made a mistake.

Here a repeat is the normal case, and that is the whole endpoint:

| | |
|---|---|
| handle new to this personality | **201**, `created: true` |
| handle already this personality's | **200**, `created: false`, **the same account** |
| handle under another of this client's personalities | **409**, naming that personality |
| handle that is not one | 400, quoting what was sent |
| personality unknown, or another client's | 404 — the id is the secret |

**200 rather than an error is load-bearing.** The roster a machine holds is
client-wide and says nothing about which emulator owns which account, so an
agent does not trust an account it did not register itself: on every restart it
re-reads its screen and registers again. If that answered 409 the machine could
never resolve its account and would never run. The handle on the screen is the
identity, not the order machines happened to enrol in — so two boxes under one
personality send two handles and get two accounts, rather than silently sharing
one and draining its cap twice.

409 is the opposite case and has to be loud: the same handle under a *different*
personality means the operator picked the wrong personality for this emulator,
which nothing downstream can detect.

New accounts take the schema's default cap rather than one the machine asks for
— a young account hits Snapchat's add-cooldown around 40 adds/day, and the
operator raises it in the CRM once it has settled.

`accounts.displayName` and `accounts.machine` record what the registering box
saw around the handle. Operator context only; both are absent from every reply,
including the one the agent parses.

The contract is `CRM-CHANGES.md` in the snap-automation repo; the tests that
hold us to it are `test/http/registration.http.spec.ts` and
`test/registration.int.spec.ts`.

## Newest first — the handout order is the efficiency

The claim hands out the **most recently queued** rows, not the oldest.

A handle can only be followed while that person is still on the emulator's Quick
Add roster, and that roster is re-rolled every time Snapchat restarts — which the
agent does deliberately after each batch, because it is the only thing that
produces new people. A row queued from an older sheet is therefore not stale, it
is **gone from the device** and cannot be followed at all.

Measured on a live account at cap 50: oldest-first spent 18 of the 50 on orphans
from the previous sheet, every one of which missed, leaving 32 follows for a full
day's budget. It also took 31 minutes rather than 11, because a miss scans twelve
pages and rewinds before giving up.

Nothing is stranded that the old order preserved — a `skipped` report is terminal,
so those rows were never coming back either way. The consequence to know is that
a handle left behind by a run of fresh sheets may never be handed out, which makes
`queued` a count of the ledger rather than of work that is still reachable.

`Assignment.note` — what the machine said when it reported back, e.g. *"no row
read as 'x' in 12 page(s) of the current Quick Add roster"* — has been written
since the beginning and selected by nothing. It is now returned by the ledger and
the targets list, because a skip with no reason is indistinguishable from a skip
whose reason nobody wrote down.

## How hard to push an account

Two numbers, one screen (**Settings**), one setting each for the whole client:

```prisma
Client.dailyCapPerAccount  Int @default(240)   -- targets handed to EACH account per day
Client.followPaceSeconds   Int @default(2)     -- seconds a machine waits between follows
```

`dailyCapPerAccount` replaces the old `Account.dailyCap` column. It is still a
**per-account** cap — each account gets that many, so adding an account adds
throughput rather than dividing it — it is only the *setting* that is shared.
What the cap protects against is Snapchat rate-limiting the account doing the
following, and that threshold is a property of Snapchat and of how old the account
is, not of which account it happens to be. Twenty accounts each carrying their own
copy of the number meant twenty places to change it and nineteen chances to miss
one.

The asymmetry worth knowing: **the cap is enforced, the pace is only served.**
`TargetsService.claim` meters against the cap inside its transaction, so a client
that ignores it still gets nothing. The pace rides out on the claim reply as
`paceSeconds` and a machine has to honour it — one running an older build keeps
using `follow_pace_seconds` from its own config file.

A young account hits Snapchat's add-cooldown at roughly 40 adds/day in testing.
Both defaults are well above that on purpose; they are the rate limit that keeps
an account alive, not a throughput knob.

## Forward or drop — there is no review

A person is either sent to an account or dropped. Nothing is held for a human,
there is no review queue and no review screen, and `AssignmentState` has no
value for "someone should look at this". An assignment row means forwarded; the
absence of one means dropped.

Four things used to produce a review item, and all four now drop:

| | |
|---|---|
| avatar and name disagree | the guard that keeps a woman with a male-reading display name out of a men-only feed |
| country confidence below the rule's `minConfidence` | the rule matched, but not on evidence strong enough to be worth acting on |
| a near duplicate | the handle is one character from one already in the ledger, under the same display name |
| `FilterRule.action = 'review'` | gone; the column is `forward` or `reject` |

Dropping is not deleting. The `Person` row stays, so widening the rules later
replays `filter` and `allocate` over stored people and can pick them up without
another vision call — the same free rule change the pipeline is built around.

**The near-duplicate case is the one that needed a schema change.** That verdict
is computed in `resolve`, from the sheet, and it used to survive only because it
was written as a `review` assignment row, where `UNIQUE (personId)` stopped a
replay from queueing the twin. With no row, the verdict had nowhere to live, and
the next country-list edit would queue both readings of one man and follow him
twice — `UNIQUE (personId)` cannot catch that, because they are two distinct
`Person` rows, which is exactly what the guard had noticed. So it is persisted:

```prisma
Person.nearDuplicateOf String?   -- the handle this one is one edit from
```

`filter` drops on that column, so the drop is reproducible from stored state
rather than from what the pipeline happened to know at the time.

The cost of all this is that **every drop is now silent**. A person who is not
forwarded leaves no row, no reason string and no screen, so "the filter is
working" and "the filter is eating everyone" look identical from the operator
UI — the `/api/stats` country rollup, which counts people against people with
assignments, is the only place the gap is visible.

## Retention — the setting that decides whether the disk fills

A sheet is ~1.2 MB and the design target is 20,000 a day: **~24 GB/day, ~8.8
TB/year** of images that are read exactly once, by the extraction call. Until
this existed there were two write paths into object storage and no delete path
at all.

**The default is to delete the image as soon as the pipeline commits**, so
storage stays flat at roughly the number of sheets in flight rather than growing
forever.

```bash
SHEET_RETENTION_DAYS=0      # 0 = on completion · N = keep N days · <0 = forever
SHEET_FAILED_KEEP_MAX=20    # newest N failures keep their image — a count, not an age
RETENTION_SWEEP_MINUTES=60
```

Deletion happens **after `allocate`**, not when extraction returns. `run()` still
has resolve → filter → allocate to go, and a throw in any of them fails the job;
BullMQ retries from the top and reads the image again. Deleting at the end of
`extract()` would turn a transient database error into permanent loss of the
sheet.

It is also not delayed until the client finishes following. Follows operate on
handles pulled from the database; the image is never consulted after extraction
produced those rows, so waiting would hold 1.2 MB per sheet for hours and buy
nothing.

Failures are the one case with no event to trigger on — that is what failure
means — so they are bounded by **count rather than age**: the newest
`SHEET_FAILED_KEEP_MAX` keep their image and older ones lose it. An age rule is
unbounded in exactly the case that matters: a gateway outage failing every sheet
for a day writes 20,000 images and then holds all of them for the full window.

20 is a diagnostic sample, not an archive — ~24 MB. Failures arrive correlated:
at the design target an ordinary 1% rate is already 200 a day, and an outage
fails every sheet the same way, so the 200th image tells you nothing the 3rd
did not.

Known limit: that cap is **global, not per client**, so one tenant failing in a
burst can evict another tenant's evidence before anyone looks at it. Fixing it
means `ROW_NUMBER() OVER (PARTITION BY clientId)` in raw SQL, since a sheet
reaches a client only through account → personality.

The hourly sweep is the safety net, not the mechanism: it catches sheets whose
immediate delete was interrupted, and failures that have aged out. It never
touches a sheet still `received` or `extracting`, because a queued job is about
to ask for those bytes.

What survives:

| | |
|---|---|
| the `Sheet` row | kept — a few hundred bytes carrying the cost and throughput history `/api/stats` reports, and the `(accountId, sha256)` uniqueness that makes a client's retry after a network blip free |
| `Extraction.rawReply` | kept — the model's verbatim answer, ~18 KB before TOAST. Replaying `filter`/`allocate` after a rule change reads this, never the image |
| the image | deleted |

`storageKey` becomes NULL, so "pruned" is a fact the database states rather than
a 404 a caller infers. `GET /api/sheets/:id/image` answers **410 Gone** for those,
not 404: the sheet and its rows are still there, only the screenshot is not.

Deleting a personality also purges its images first, before the cascade destroys
the rows holding their keys — otherwise those objects survive with nothing left
in the database that knows their names.

## Known gaps

- `Client.monthlyBudgetUsd` is enforced nowhere. At ~$0.08 a sheet an uploader
  in a loop is unbounded.
- The templated-output guard cannot fire: `distinctCuesRatio` reads a `cues`
  field the shipped prompt does not ask for.
- The gender filter leaks. Measured on five women, so treat the rate as
  indicative — see `vlm_eval/ROUTING.md`.
- Docker has never been run against this compose file.
