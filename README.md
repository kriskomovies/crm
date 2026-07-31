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
| `test/`, `pages/` | fixtures: the 99-entry contact sheet and the raw captures it was built from |

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

312 across four projects: `unit` (pure functions), `int` (real Postgres —
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

## Known gaps

- `Client.monthlyBudgetUsd` is enforced nowhere. At ~$0.08 a sheet an uploader
  in a loop is unbounded.
- The templated-output guard cannot fire: `distinctCuesRatio` reads a `cues`
  field the shipped prompt does not ask for.
- The gender filter leaks. Measured on five women, so treat the rate as
  indicative — see `vlm_eval/ROUTING.md`.
- Docker has never been run against this compose file.
