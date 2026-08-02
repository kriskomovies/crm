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

312 across four projects — 303 on a fresh clone, since the nine sheet-driven
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
