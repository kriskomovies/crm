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
`SHEET_RETENTION_DAYS` existed there were two write paths into object storage
and no delete path at all.

```bash
SHEET_RETENTION_DAYS=14     # 0 keeps every image forever
RETENTION_SWEEP_MINUTES=60
```

The worker sweeps hourly and deletes the stored image of any sheet older than
the window whose status is terminal — never one still `received` or
`extracting`, because a queued job is about to ask for those bytes. What
survives:

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
