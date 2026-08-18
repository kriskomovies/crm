# E2E readiness — the four questions, answered

Written 2026-08-14 against production `88.99.165.27:/opt/crm`, client **kris agency**:
`extractionModel = gemini-3.6-flash`, `dailyCapPerAccount = 240`, `followPaceSeconds = 8`,
`monthlyBudgetUsd = 100`. Four real extractions exist in that database. Everything below
says which of its numbers are measured and which are derived.

---

## 1. Will we follow 240 people? — **No. ~40, then the cap burns itself.**

The only measurement that exists puts a young account's Snapchat add-cooldown at
**~40 adds/day** (`README.md:215`). Nothing in the shipped client detects that cooldown,
so follows 41 through 240 are attempted, fail, and consume cap anyway.

What happens at follow ~41, traced through the code:

| | |
|---|---|
| `steps.add_friend` | polls for the blue "Added" state 10s, then diffs two frames 0.5s apart |
| the measured cooldown behaviour | a **silent revert to "Add"** (`docs/strategy.md` §5) — a static button, so the diff sees no motion |
| therefore the return value | **`failed`**, not `rate_limited`. The `rate_limited` branch mostly never fires |
| `agent.work_targets` | increments `counts["failed"]`, logs it, **continues at full pace** |
| `TargetsService.report` | sets `state = 'queued'` but leaves `handedOutAt` set |
| `claim` | excludes rows with a fresh `handedOutAt` — *"It waits for tomorrow instead"* |
| `handedOutToday` | counts `handedOutAt >= midnight`, so the slot is **spent for the day** |

Cost of one failed attempt rises from ~2s to ~13s (10s timeout + the diff + screenshots).
Spending the remaining ~200 slots takes roughly **8 cycles × 12.6 min ≈ 101 min**. The day
lands at ~2h of wall clock, ~40 real adds, **~17% yield**, and the agent reports every one
of those cycles as `WORKED` because `work_targets` only checks `remaining != 0`. The status
page says "followed this batch" while nothing is being followed.

Two knock-on effects worth naming:

- The dismiss pass dies for the rest of the day — `_may_dismiss` returns `False` as soon as
  any follow failed and requeued (`agent.py:910-914`).
- The requeued ~200 are **destroyed, not deferred**. Tomorrow the handle is gone from the
  device, `follow_handle` returns `skipped`, and `skipped` is terminal
  (`targets.service.ts:191-195`).

`docs/strategy.md` §6 predicted "≈2h for 240" and it got the clock right. It assumed
10-minute cooldown backoffs that were never shipped — the `COOLDOWN_AFTER = 5` rule lived in
a standalone probe `emulator.py:60-62` records as deleted.

**The 240 default is not a throughput knob and should not be run as one until the cooldown
threshold is measured on this account.**

---

## 2. Will we get new people each cycle? — **Unknown. It has never been measured, not once.**

This is the honest answer and it is the most uncomfortable one in the report, because the
whole question of whether 240/day is even arithmetically reachable turns on it.

`state/agent.log` contains 236 `sheet.built` lines. Every one of them is
`entries=100 pages_used=9 bytes=1177385` — the same canned nine-page corpus in `pages_dir`,
re-montaged 236 times. All `sheet.captured` lines are `acct=seam-test` against emulator
index 4, which the same log records as `EmulatorUnavailable`. All 22 `follow.result` lines
are synthetic (`handle=a1`, `b2`, `c3`, `z9`). `rate_limited` appears **zero** times.

Exactly **two real cycles** exist, 2026-07-31 and 2026-08-02. Both uploaded identical bytes,
both deduped on `UNIQUE (accountId, sha256)`, both recorded `new_people=0 queued=0` and
`targets.claimed asked=25 got=0`. Neither made a follow. So every `no_new_handles` in that
log is a tautology about a duplicate upload, **not an observation of Quick Add**.

The mechanism is there: `restart_app` is the only re-roll lever — *"Quick Add serves one
roster for as long as the app stays up"* (`emulator.py:236-259`) — fired once after `WORKED`,
twice after `NO_NEW`, never after `CAP_SPENT`. Client-side dedupe is byte-exact and
**within one cycle only**; across cycles the only dedupe is `Person @@unique([personalityId, handle])`.

Per-cycle new targets = `99 × r × f`.
`f`, the filter forward rate, is measured. `r`, the fraction of a re-rolled roster that is
genuinely new, is **unmeasured, undocumented and absent from the log**. And `r` decays with
account count — `refusedHandles` exists because *"on the tenth roster this is the larger of
the two populations"* (`targets.service.ts:245-250`).

If `r ≈ 0.15`, a cycle yields ~15 new people, ~1.4 survive the filter, and 240/day is
impossible regardless of what the cooldown does. **Measure `r` before anything else** — see
Run A below. It costs no adds, no cap and no API calls.

### A number the investigators disagreed on

`f` is quoted two ways and they are not close:

| source | forward rate | forwarded per sheet |
|---|---|---|
| `vlm_eval/ROUTING.md`, `gemini-3.6-flash` on this client's country list | **9/99** | 9 |
| working assumption used in the cost pass | 17% | 16.8 |

That is a 1.9x spread and it propagates straight into sheets/day and therefore into the
whole extraction bill. Both are carried through the cost table below rather than averaged.
The 9/99 figure is the measured one; treat 17% as an optimistic bound.

---

## 3. The 8 seconds — **it is not the constraint. It buys you 1.5h of headroom you do not need.**

`followPaceSeconds = 8` is the wait *between* targets, served on the claim reply as
`paceSeconds`. It applies whether the target is followed or rejected. On top of it:

| | seconds | source |
|---|---|---|
| real work per successful add | **5.4** | derived from `README.md` "Newest first": 50 targets, 11 min, minus 49×8 pace |
| real work per miss (handle not on the roster) | **~72** | same README: 32 hits + 18 misses in 31 min; matches `_scan` walking `SCAN_PAGES=12` twice |
| real work per cooldown attempt | **~13** | 10s `add_friend` timeout + diff + screenshots |
| pace | 8 | config |

A 25-target batch is 25×5.4 + 24×8 = **327s = 5.5 min** of following inside a **~9.4 min**
cycle. The rest is capture (~60s, ~13–14 pages since the swipe distance was cut in
`capture.py:46-50`), extraction (~81s), restart (~25s) and the 60s `between_cycles` wait.

Spending 240 at `claim_limit = 25`:

| scenario | cycles | wall clock |
|---|---|---|
| queue always full, 25/cycle | 10 | **~1h 34m** |
| queue limited to 9 forwarded/sheet | 27 | **~2h 37m** |
| reality with the cooldown at ~40 | 2 productive + 8 burn | ~2h, ~40 real adds |

All three fit inside a day with hours to spare. **Dropping the pace would not buy
throughput; it would only shorten the interval in which Snapchat sees the adds.** Leave it
at 8. The binding constraints are the cooldown and `r`, in that order.

---

## 4. Will the cheaper model work? — **Yes on transcription and cost. No on the gender filter.**

`gemini-3-flash-preview-nothinking`, scored against the 99-row hand-keyed `ground_truth.json`
on the same 99-entry production montage with the **live production prompt** lifted out of
`server/src/extraction/sheet-task.ts`:

| | nothinking | gemini-3.6-flash (today) |
|---|---:|---:|
| handle exact | **98/99** | 99/99 |
| display name exact | 94/99 | **97/99** |
| completion tokens | **7,459** | 16,719 |
| $/sheet (measured off the gateway spend counter) | **$0.0233** | $0.1282 |
| seconds | **47.9** | 63.0 |
| skin tone within one bucket | **~77/91** | ~66/91 |
| anglophone bucket | 64/99 | 59/99 |
| **women forwarded to a men-only feed** | **3 of 5** | **1 of 5** |

Modelling `combinePresents` exactly (`normalize.ts:178-198`: the avatar read wins outright,
a woman is rescued only when the *name* positively reads female), nothinking sends
`samicollettee`, `charlie_gafa` and `hehjwy20` through. 3.6-flash leaks only `charlie_gafa`.
The failure is structural, not sampling noise: nothinking is wrong on **4 of 5 women (80%)**
and 5 of 93 others (5%); 3.6-flash on 2 of 5 women (40%) and 5 of 94 others (5%).

And it forwards *more* people overall (64 vs 59 anglophone), so it widens the funnel while
raising the share of it that is wrong. That is the trade. It is not a cost decision.

`hybrid_eval.py` gives the way out — the avatar pass is already a separate call, so the two
passes need not use the same model:

| configuration | women leaked | men lost | $/1000 profiles |
|---|---|---|---|
| nothinking, sheet only | 3/5 | 1/87 | 0.235 |
| nothinking + own avatar pass | 2/5 | 1/87 | 0.315 |
| **nothinking sheet + 3.6-flash avatar pass** | **1/5** | 1/87 | **0.766** |
| 3.6-flash sheet only (**today**) | 1/5 | 0/87 | 1.295 |
| 3.6-flash + own avatar pass | **0/5** | 1/87 | 1.825 |

The hybrid matches today's leak rate at **41% below today's cost**. That, not the flat
switch, is the recommendation.

**Caveat the harness insists on and so does this report: five women.** The *ranking* is
solid across every run. The absolute leak rates carry roughly ±20 points. The README already
lists this as a known gap; nothing here closes it.

One more difference, in the cheap model's favour: `gemini-3.6-flash` answers `hebrew` for
three ordinary English first names, and "Hebrew" is not in the ORIGINS list in
`rules.controller.ts`, so `normCountry` stores it and **no checkbox can ever reach those
three again**. Silent data loss. nothinking does not do this.

---

## The eval gap — there isn't one, and the benchmark the operator remembers is a different image

**The cheap model has been measured at 99 entries on a production-shaped montage. Three
times.** This is the one place where the working assumption going in was wrong.

| run | prompt | calls × entries | handles | $/sheet | sec |
|---|---|---|---|---|---|
| `sheet_gemini-3-flash-preview-nothinking_cost.json` | `sheet_task.py` port, 4 fields | **1 × 99** | **98/99** | $0.02414 | 39.6 |
| `sheet_gemini-3-flash-preview-nothinking_r11.json` | same | 3 × 33 | 99/99 | ~$0.0267 | 64.0 |
| `golden_gemini-3-flash-preview-nothinking.json` | **live production prompt**, 8 fields | **1 × 99** | **98/99** | $0.02333 | 47.9 |

The 33→99 transcription penalty is real and tiny: one handle and five emoji. Errors do not
compound.

**The montage geometry matches production.** `C:\Users\Krisko\Desktop\snap-automation\src\snapclient\sheet.py`
crops at `LIST_X0 = 37`, `CELL_W = 345` — *"..to x=382, where the Add button starts"* — 3
columns of 345×87 native pixels, never scaled, *"the same geometry as ../test/main/all99_3col.png"*.
Verified by eye on the top three grid rows of the golden sheet: **avatar + display name +
@handle, nothing else.** No Add pill, no X, no chrome. The operator's memory that the
benchmark image was "clean" is correct, and production's montage is clean in the same way.

**What the operator is remembering is a different corpus.** The harness uses "33" in four
incompatible senses; the one behind the "33/33 agreement, 32/33 handles, $0.00859, 15.7s"
result in `snap-results/03_readme.txt` is `wide_sheet.png` — a separate, freshly captured
**33-person roster at 436px cells in 2 columns, with no ground-truth key at all**, scored
only by A/B agreement between two models. `golden_eval.py:9-10` states what was wrong with
it: *"that roster was 30 men and 3 placeholders"* — **zero women**, and a woman forwarded to
a men-only feed is the error that costs money.

`snap-results/06_golden_sheet_verdict.txt` records that the 33-entry result was misleading
in direction, not merely thin: on the 33-person sheet the cheap model **won** on handles
32/33 to 33/33's rival; on the keyed 99 it **loses** 98/99 to 99/99. One handle either way
on one sheet was never evidence of anything.

**So: the transcription result transfers. The result the operator actually remembers came
from an unkeyed image with no women in it, and on the field that decides money it does not
transfer at all.** Nothing further needs to be run to answer question 4 — `golden_eval.py`
and `hybrid_eval.py` already did it, both offline.

Two stale documents to stop quoting:

- `APIMART.md` ("40 runs over 21 models") predates this model entirely. It will tell you the
  cheap model was never tested. It is stale, not true — every nothinking result lives in
  uncommitted August 4–5 work.
- `APIMART.md:40` still quotes $8.58/M out for `gemini-3.6-flash`, the superseded
  balance-endpoint estimate its own Cost section says was ~35% high.

---

## Cost — real numbers

All four production extractions, `gemini-3.6-flash`, `profilesFound = 99` on every one:

| # | prompt tok | completion tok | usd | sec |
|---|---|---|---|---|
| 1 | 1,904 | 15,135 | 0.094720 | 100.96 |
| 2 | 1,868 | 18,716 | 0.116634 | 74.63 |
| 3 | 1,884 | 24,316 | 0.150979 | 80.31 |
| 4 | 1,868 | 17,565 | 0.109579 | 58.88 |
| **mean** | **1,881** | **18,933** | **0.117978** | **78.69** |

Input is stable to ±1.9%. Output swings **15,135 → 24,316, a 61% spread, at temperature 0
on the same 99 objects** — that is the thinking budget wandering, and it makes per-sheet cost
range $0.0947–$0.1510.

**Output is 98.4% of the bill** ($0.1161 of $0.1180). Of those 18,933 output tokens, the JSON
that reaches the parser is ~5,900–6,000. The other **~13,000 tokens — 69% of output, 67% of
the entire bill, ~$0.079/sheet — is hidden reasoning nobody ever reads.** That is what the
cheap model deletes: 7,459 tokens against 16,719 for the same 99 objects. Note the mechanism,
because it is not the one people assume — `pricing.py:71-75`: *"the -nothinking variants are
priced identically to their thinking twins, so the saving is not in the RATE, it is in how
many output tokens the model emits."*

**Why $0.118 and not the README's ~$0.08.** The README figure is the July benchmark on a
3-field prompt (11,276 output tokens → $0.0707). `sheet-task.ts` now ships 7 fields — it
added `nationality_confidence`, `avatar_presents_as`, `name_presents_as`, `skin_tone`. Output
went 11,276 → 18,933, a ratio of 1.68x; cost went 1.67x. The delta is entirely the field
list, ~$0.0118 per added field per sheet. Nothing is mispriced: `priceUsd` reproduces the
stored `usd` to the last decimal on all four rows, and the published rate ($1.20/$6.00)
lands within 1.8% of the measured one ($1.02/$6.13).

**`README.md:327` and `schema.prisma:48` are both wrong and should be corrected**: real cost
is **$1.192 per 1,000 profiles**, not $0.74 and not ~$0.08/sheet.

### Per account-day and per account-month

Sheets/day = `dailyCapPerAccount ÷ forwarded-per-sheet`. Both forward rates carried:

| model | $/sheet | f = 9/99 → 27 sheets/day | f = 17% → 14.3 sheets/day | capped at the real ~40 adds/day |
|---|---|---|---|---|
| `gemini-3.6-flash` (today) | 0.1180 | $3.19/day · **$95.60/mo** | $1.68/day · $50.47/mo | $0.52/day · $15.72/mo |
| worst sheet seen | 0.1510 | $4.08/day · $122.34/mo | $2.15/day · $64.58/mo | $0.67/day · $20.11/mo |
| nothinking (measured) | 0.0233 | $0.63/day · **$18.87/mo** | $0.33/day · $9.96/mo | $0.10/day · $3.10/mo |
| hybrid (nothinking sheet + 3.6 avatar pass) | ~0.0758 | $2.05/day · $61.40/mo | $1.08/day · $32.41/mo | $0.33/day · $10.09/mo |

Read the middle-left cell: **on today's model, at the measured forward rate, one account at
the 240 cap costs $95.60/month against a $100 budget.** Two accounts breach it inside the
first month. And these numbers all assume `r = 1` — every re-rolled roster fully new. Lower
`r` means more uploads per useful target and a strictly larger bill.

### The loop, which is hours not months

`monthlyBudgetUsd` is in `schema.prisma`, the init migration and `seed.ts`, and is **read
nowhere in `server/src`**. Nothing rate-limits `POST /sheets`: the sha256 dedupe makes a
re-upload of the *same bytes* free but a genuine Quick Add re-roll produces distinct images
by definition, and `dailyCapPerAccount` throttles targets handed *out*, which is downstream
of the money — `extract()` calls the gateway before any cap is consulted.

| | 3.6-flash | nothinking |
|---|---|---|
| one extraction | 78.7s | 47.9s |
| sheets/hour, single-threaded loop | 45.7 | 75.2 |
| $/hour | **$5.39** | $1.75 |
| hours to burn the $100 budget | **18.5** | 57 |

Two uploaders halve it. 24h unattended on today's model is **$129**; 30 days is $3,884.
The cheap model does not close the hole, it widens the window from overnight to a working
week. The fix is a `SUM(usd)` over `extractions` for the client's current month, checked in
`extract()` before `gateway.ask()`. There are four rows in that table; the query is free.

---

## The cap vs the cooldown — the finding to act on

Everything above reduces to one sentence: **`dailyCapPerAccount = 240` and Snapchat's
~40/day cooldown differ by 6x, and the client cannot tell the difference between them.**

At follow ~41 the cap stops protecting the account and starts destroying inventory:

1. `add_friend` returns `failed` (not `rate_limited`, because a reverted button does not move
   between frames).
2. `report` requeues the row but leaves `handedOutAt`, so `handedOutToday` counts it. **The
   cap slot is gone for the day.**
3. `claim` will not hand it back today. Tomorrow the handle is off the device, so
   `follow_handle` returns the terminal `skipped`. **The row is destroyed, not retried.**
4. `work_targets` returns `WORKED`, the log says `follow.batch_done failed=25`, and nothing
   anywhere reads that number.

Price of running the 240 cap once, today: ~200 assignment rows destroyed, ~200 cap slots
spent on adds that cannot land, ~101 extra minutes of emulator time, ~40 real adds, and an
account that has spent two hours signalling automation to Snapchat's rate limiter. The
extraction cost of that day is real money too — 27 sheets at $0.118 is **$3.19 for ~40
follows, $0.08 per landed add**.

There is no consecutive-failure detector anywhere in `src/snapclient`. I grepped for it.

---

## Recommended test plan — ~2h 20m, ~1h 15m of it touching the emulator

**Set `dailyCapPerAccount = 60`, not 240, and `claim_limit = 10`.** Sixty crosses the ~40
boundary in cycle 4–5 and produces the same cooldown evidence for ~20 wasted slots instead
of ~200. Running to 240 to prove the account cannot do 240 teaches nothing the first cooldown
does not and costs a day of cap plus 200 destroyed rows.

### Blocker to clear first

`config.toml` has `pages_dir` and **no `emulator_index`**. As written, `device()` returns
None, `simulate()` fires, every follow is faked — **and still reported to the server as
`followed`** (`agent.py:662-676`). Running e2e on this file poisons the ledger with adds that
never happened. Add `emulator_index`, delete `pages_dir`.

Second blocker, if the cheap model is in scope for the run: **`gemini-3-flash-preview-nothinking`
is not in `pricing.ts`'s `PRICES` table**, and `priceUsd` returns 0 for unknown models by
design. Point `client.extractionModel` at it today and every `extractions.usd` writes
`0.000000` — cost telemetry zeroes at exactly the moment you are measuring whether the
switch paid. Add the row ($0.40/M in, $2.40/M out) **before** the A/B.

### Instrumentation — none of this is logged today

| add | answers |
|---|---|
| `add_friend` outcome per follow (`added` / `rate_limited` / `failed`) | Q1. Three different worlds currently collapse into the word `failed` |
| index of the **first** failed add of the day | the real cooldown threshold. "~40" is one 2026-vintage observation |
| per-follow duration | separates 5.4s hits from 72s misses from 13s cooldown attempts |
| capture wall clock and page count | the ~60s and ~13–14 pages are derived, never observed |
| distinct-handle overlap between consecutive captures | **`r`** |

### Run A — the re-roll yield. 10 min. Zero adds, zero API calls, zero cap. **Do this first.**

```
python -m snapclient.capture --index N --out ./r0
python -m snapclient.capture --index N --restart 1 --out ./r1      # through r5
```

Count distinct people across `r0..r5` with `sheet.py`'s existing byte-exact `_identity_key`.

**Pass:** `r ≥ 0.4` — a restart yields ≥40 genuinely new people per roster, so a cycle
produces ~4 forwarded at `f = 9/99` and the cap is at least approachable.
**Fail:** `r ≤ 0.15`. ~1.4 new targets per cycle makes 240/day arithmetically impossible
and Runs B and C are unnecessary — the fix is roster acquisition, not pacing.

### Run B — the cooldown boundary. 6 cycles, ~45 min. Cap 60, `claim_limit` 10.

**Pass:** all 60 land, with no `failed`. Then ~40 was pessimistic and the cap can be raised
in steps with the same instrumentation.
**Fail (expected):** first `failed` appears somewhere in cycle 4–5, every subsequent attempt
fails, ~13s each. Record the index, whether it presents as `failed` or `rate_limited`, and
whether any add recovers unprompted.

### Run C — only if B shows recovery. ~40 min.

Idle 15 min after the first cooldown, claim 5 more. Answers `strategy.md` §6's open question
("is 10 min enough?") — the assumption the whole pacing plan rests on, still listed unmeasured
in §10.

### Q4 needs no emulator run at all.

`golden_eval.py` and `hybrid_eval.py` already answer it against the keyed 99. If you want a
production A/B, run it on the *hybrid* config and read `completionTokens`, not dollars —
tokens are the thing that moved, and dollars will lie until `pricing.ts` has the row.

---

## Risks

- **Irreversible: the ~200 destroyed assignment rows** if the 240 cap is run before the
  cooldown is understood. `skipped` is terminal; those people are not retried on any later
  day. This is the reason for cap 60.
- **Irreversible: account health.** Two hours of failing adds at 8s pace is the exact
  signature a rate limiter is built to catch. The cap is *"the rate limit that keeps an
  account alive, not a throughput knob"* — the README already says this.
- **Expensive: the unbounded loop.** $5.39/hour today, $100 gone in 18.5 hours, and
  `monthlyBudgetUsd` cannot stop it because nothing reads it. Do not leave an uploader
  running unattended during any of these runs.
- **Silent: `pricing.ts` has no row for the cheap model**, so switching zeroes cost telemetry
  rather than erroring.
- **Silent: simulated follows are reported as real.** Fix `config.toml` before any run.
- **Silent: `gemini-3.6-flash` writes `hebrew` into `normCountry`**, a value no rule checkbox
  can ever match. Those people are unreachable, today, in production.
- **Statistically thin: five women.** Every gender-leak number in this report rests on them.
  The ranking is stable across runs; the rates are ±20 points. Do not report "3/5 vs 1/5" as
  60% vs 20% to anyone.
- **Tooling:** `field_verdict.py:123` and `ab_matrix.py:49` crash on Windows cp1252 when they
  hit an emoji display name — they emit correct output right up to the point they die
  mid-table. `field_cost.py:19` already has the fix (`io.TextIOWrapper(..., errors="replace")`).
