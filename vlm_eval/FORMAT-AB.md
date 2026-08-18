# Format A/B — fewer entries, bigger cells, and whether the cheap model can be trusted

Three claims were put to the corpus, with money on them:

1. an image holding **~33 entries** reads better than one holding 99;
2. cells containing **only avatar + display name + @handle** read better than cells with Snapchat chrome;
3. **bigger / higher-quality cells** read better — *"the bigger the images and the better quality the better the reading from the AI"*.

**Claim 2 was already true in production and was not bought.** `snap-automation/src/snapclient/sheet.py:38-40` crops `LIST_X0=37, CELL_W=345` — "..to x=382, where the Add button starts" — in native framebuffer pixels, never rescaled. No Add pill, no X, no chrome. The keyed montage is the same geometry. Nothing to test.

Claims 1 and 3 were bought. **Total spend: $0.7413**, measured off `pricing.balance_units()` (789.6312 → 848.9404 units at 80.01 units/USD), 17 serial calls. Of that, $0.5824 is the six paid arms below and $0.1589 is one discarded run (see Known limits).

Everything is scored against the keyed 99 (`ground_truth.json`, 99 unique handles: 87 man / **5 woman** / 5 ambiguous / 2 not-a-person) with the **live production prompt** pulled out of `server/src/extraction/sheet-task.ts`, aligned by handle, routed through the `normalize.ts` `combinePresents` port in `golden_eval.score()`. **Five women is the entire gender sample. Every gender figure below is a count out of 5.**

## The matrix

Builder `fmt_build.py` → `results/fmt/`; runner `fmt_run.py` → `results/fmt/run_<model>_<V*>.json`.

| model | var | cell px | e/img | calls | handle | name | avatar | women avatar ok | **women LEAKED** | out tok | $/sheet | $/1000 profiles | sec |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| nothinking | **V1** | 345 native | 99 | 1 | 98/99 | 95/99 | 89/98 | 1/5 | **3/5** | 7,459 | $0.0233 | $0.236 | 47.9 |
| nothinking | **V4** | 690 | 99 | 1 | 97/99 | 92/99 | 88/97 | 1/5 | **3/5** | 7,217 | $0.0226 | $0.228 | 35.9 |
| nothinking | **V2** | 436 | 33 | 3 | 99/99 | 97/99 | 92/99 | 3/5 | **2/5** | 7,871 | $0.0264 | $0.267 | 43.3 |
| nothinking | **V3** | 690 | 33 | 3 | 99/99 | 97/99 | 92/99 | 3/5 | **2/5** | 7,916 | $0.0265 | $0.268 | 49.7 |
| 3.6-flash | **V1** | 345 native | 99 | 1 | 99/99 | 97/99 | 92/99 | 3/5 | **1/5** | 16,719 | $0.1282 | $1.295 | 63.0 |
| 3.6-flash | **V4** | 690 | 99 | 1 | 99/99 | 98/99 | 91/99 | 3/5 | **2/5** | 13,993 | $0.1078 | $1.089 | 85.0 |
| 3.6-flash | **V2** | 436 | 33 | 3 | 99/99 | 98/99 | 92/99 | 3/5 | **2/5** | 25,166 | $0.1972 | $1.992 | 122.2 |
| 3.6-flash | **V3** | 690 | 33 | 3 | 97/99 | 98/99 | 91/97 | 3/5 | **1/5** | 25,803 | $0.2019 | $2.039 | 149.3 |

Both **V1 rows are reused, not re-bought** — `results/golden_<model>.json` is already the live prompt over the same image, and `fmt_build.py` verified `v1_99e_3c_345px.png` is byte-identical to `test/main/all99_3col.png`. They reproduce the brief exactly (98/99, 95/99, 3/5 leaked; 99/99, 97/99, 1/5 leaked), which is also the proof that this scorer is the harness's own and not a new one.

Avatar denominators of 98 and 97 are entries where the model never emitted a matching handle. An unread entry is counted missing, not wrong, and is never forwarded either.

## 1. Is the cheap model good enough?

**On transcription, yes — comfortably. On the field that decides money, no. Only in a hybrid.**

`gemini-3-flash-preview-nothinking` banded at 33/image reads **99/99 handles and 97/99 display names** — better than deployed `gemini-3.6-flash` at production geometry (99/99, 97/99) on names by nothing and on handles by nothing. It is a tie on transcription, at **$0.0264/sheet against $0.1282/sheet, 4.9x cheaper** (derived from the two measured $/sheet).

The gender filter is where it loses. Deployed 3.6-flash forwards **1 of 5** women to a men-only feed. The best the cheap model reached in any format is **2 of 5**. One woman, on a sample of five, is the entire difference — and it is a difference in the direction the product cannot absorb, because a woman in a men-only feed is the failure a client notices.

The two the cheap model never gets, at any layout, are `charlie_gafa` and `hehjwy20`: both read `avatar=man`, `name=ambiguous`, so routing has nothing to catch them. These are the same two `ROUTING.md` already identified as vision-hard. 3.6-flash only rescues `hehjwy20` when its *name* field happens to read `woman` (V1 and V3) — its avatar verdict on her is `man` in all four of its runs too. That rescue is luck in the name channel, not better avatar reading.

**The hybrid that does match the deployed leak count**, measured offline by `hybrid_eval.py` over run files already on disk: **nothinking for the sheet + `gemini-3.6-flash` for a separate avatar-only pass** — **1/5 women leaked, 1/87 men wrongly held, $0.766/1000 profiles**, against today's 3.6-flash-only **1/5 leaked, 0/87 men held, $1.295/1000**. Same leak count, ~41% less money (derived), at the price of one man held per 87. Note that `hybrid_eval.py:28-31` prices from hardcoded constants, not from a bill; re-derive them before anyone spends on the strength of that line.

## 2. Does 33-per-image beat 99?

**For the cheap model, yes, and it is the only thing in this whole matrix that moved the gender number. For the expensive model, no — it makes it worse and costs half again as much.**

| | nothinking 99/img (V1) | nothinking 33/img (V2) |
|---|---|---|
| handle exact | 98/99 | **99/99** |
| display name exact | 95/99 | **97/99** |
| avatar field | 89/98 | **92/99** |
| **women avatar read correctly** | **1/5** | **3/5** |
| **women leaked** | **3/5** | **2/5** |
| $/sheet | $0.0233 | $0.0264 (**+13%**) |
| seconds | 47.9 | 43.3 |

| | 3.6-flash 99/img (V1) | 3.6-flash 33/img (V2) |
|---|---|---|
| **women leaked** | **1/5** | **2/5** |
| $/sheet | $0.1282 | $0.1972 (**+54%**) |
| seconds | 63.0 | 122.2 |

**The cost of banding is real and is easy to forget.** Three calls re-send the 3,265-character prompt three times. Measured on V1, that prompt is **1,904 prompt tokens** per call (of which 1,100 are image tokens), so banding pays for two extra copies. Derived at the `vlm_eval/pricing.py` table rates: **+$0.0015/sheet** for nothinking, **+$0.0046/sheet** for 3.6-flash. That is about half the cheap model's increase — and only a *twelfth* of the expensive model's, because 3.6-flash's real banding cost is that it emits **25,166 output tokens for the same 99 people instead of 16,719** (+50%, measured). It reasons three times.

Independent support at the *native* 345px geometry, three 3-column bands of 11 grid rows: `sheet_gemini-3-flash-preview-nothinking_r11.json` also lands at **2/5 leaked, 3/5 avatars correct**, matching V2 and V3 exactly. That run used the older `sheet_task.py` port prompt (9 fields, `bald`, no `skin_tone`), not the live one, so it corroborates rather than proves.

## 3. Do bigger cells help?

**No. This is the one belief the data contradicts outright, and it does so cleanly.**

The isolation is **V1 vs V4**: same 99 entries, same 3-column layout, same prompt, same model — only the cells change, 345px → 690px, a 4x area upscale. For the cheap model:

| | V1 (345px) | V4 (690px) |
|---|---|---|
| **women read correctly** | 1/5 | **1/5** |
| **women leaked** | 3/5 | **3/5** |
| handle exact | 98/99 | 97/99 |
| display name exact | 95/99 | 92/99 |

Not merely the same counts — the **same three women**, with the **same avatar and name verdicts in both runs** (`samicollettee`, `charlie_gafa`, `hehjwy20` forwarded as men; `kylee258082` saved only by name disagreement). Transcription got slightly *worse*. Doubling the pixels changed nothing it was asked to change. For 3.6-flash, V4 was actively worse on the deciding field: 1/5 leaked → 2/5.

**The mechanism is in the token counts and it settles the argument.** Image tokens do not move with resolution:

| variant | megapixels | prompt tokens | **image tokens** |
|---|---|---|---|
| V1 | 2.97 | 1,904 | **1,100** |
| V4 | 11.89 | 1,904 | **1,100** |
| V2 | 1.63 | — | 1,078 |
| V3 | 3.96 | — | 1,056 |

The encoder normalises to ~1,056–1,100 image tokens by aspect ratio, not by area. A 4x-area upscale hands the model **literally the same tile budget**. There is nothing for a bigger cell to spend.

And there is a second reason it could never have worked here: **345px is the native capture width.** Production crops it out of the framebuffer; there is no larger source on this machine. Every cell above 345px in this matrix — V2's 436, V3's 690, V4's 690 — is `INTER_CUBIC` interpolation of the same pixels (`fmt_build.py`, recorded as `_caveat` in `results/fmt_manifest.json`). So the experiment tested "does resampling help", the answer is no, and the answer to the operator's actual question — "does a physically larger capture help" — **remains unmeasured and would require a capture-side change to ask.**

The two 33-entry arms make the same point from the other side: V2 at **436px** and V3 at **690px** are a perfect tie — 99/99, 97/99, 92/99, 3/5, 2/5 on both. Hold entries constant and pixels do nothing; hold pixels constant and cut entries and the gender number moves. **Claims 1 and 3 were bundled in the remembered result. Split, claim 1 does all the work and claim 3 does none.**

This is consistent with the only prior clean isolation, `avatars_gemini-3.6-flash_plain_x1` vs `_x3`: 4/5 women at both scales, and 3x upscale *lost* a man (87/87 → 86/87).

## 4. The silhouette fix

Production refuses real men whose avatar is a default coloured silhouette, because `normalize.ts:178-186` `combinePresents` returns the avatar verdict outright when it is `not-a-person`, overriding a name that reads `man`. The proposed fix: when `avatar = not-a-person` **and** `skin_tone = placeholder`, fall through to the name.

Measured with `placeholder_eval.py` (offline, no model calls; its port passes 16/16 against `server/src/extraction/extraction.spec.ts` and independently reproduces both known golden leak counts):

| | nothinking today | nothinking proposed | 3.6-flash today | 3.6-flash proposed |
|---|---|---|---|---|
| men forwarded (of 87) | 86 | 86 | 87 | 87 |
| **women forwarded (of 5)** | **3** | **3** | **1** | **1** |
| total forwarded (of 99) | 94 | 94 | 93 | 93 |

**0 men recovered, 0 extra women leaked, both models.**

That is a **structural zero, not a null result about silhouette men**, and the difference matters. The gate fires on exactly two entries per model — `stefi24494` and `btu1702`, the only two `not-a-person` in the key, correctly labelled by both. Fall-through then reads the name, and the name is never `man` (nothinking: `woman`/`ambiguous`; 3.6-flash: `ambiguous`/`ambiguous`). **The keyed 99 contains no default-silhouette man. It cannot test this rule.**

The motivating evidence lives on an unkeyed sheet, `results/bakeoff_gemini-3.6-flash_live.json` (97 entries, one call): 12 entries read `avatar = not-a-person`, 9 of them carrying `name_presents_as = man`. Two things follow, both bad for shipping it now:

- **0 of those 97 entries carry a `skin_tone` field at all.** That run's prompt did not emit tone, so `normSkinTone(null)` returns null and **the gate as specified would fire zero times on the very sheet that motivated it.** (The *live* prompt does emit `skin_tone`, so the gate is live-testable — it has simply never been tested.)
- An **ungated** fall-through (drop the tone condition) would forward 9 of those 12. **How many of the 9 are women is not computable** — that sheet has no key.

**Recommendation: hold.** The number that decides this change has no measurement on any corpus on disk, and the corpus that has a key contains none of the population the change is about.

## What to change, in order

### 0. Stop pursuing bigger cells. No edit; delete the belief.

Worth: the two-repo capture change it would otherwise justify, and the ~$0.15 the V4 arm cost to retire it in writing. V1 vs V4 is 3/5 leaked either way, same three women, and image tokens are identical at 4x the area.

### 1. If the leak count must not regress — the hybrid. `server/src/pipeline/pipeline.service.ts`

Second call per sheet, avatar-only, on `gemini-3.6-flash`; sheet transcription on nothinking. `avatarPrompt(n, cols)` already exists at `sheet-task.ts:59+` and is unused by the pipeline. Measured (`hybrid_eval.py`, offline over stored runs): **1/5 leaked, 1/87 men held, $0.766/1000 profiles** vs **1/5 leaked, 0/87 held, $1.295/1000** today.

Worth **$0.0524/sheet** of 99 (derived from those two $/1000 figures), **$52.40 per 1000 sheets**. Both cost figures are `hybrid_eval.py`'s hardcoded constants, not a bill — **re-derive before committing.**

### 2. If cost is the goal — switch model *and* band, together. Three edits, one repo.

Banding alone is a loss for 3.6-flash (+54%, 1/5 → 2/5 leaked). The cheap model alone at 99/image is a bigger loss (3/5 leaked). Only the pair is worth anything.

**2a.** `server/prisma/schema.prisma:43` — `extractionModel String @default("gemini-3.6-flash")` → `@default("gemini-3-flash-preview-nothinking")`, plus an `UPDATE` on existing `Client` rows. The column is per-client, so this can be rolled one client at a time.

**2b.** `server/src/extraction/pricing.ts:27-39` — **add a `PRICES` row for `gemini-3-flash-preview-nothinking` in the same edit.** `priceUsd` returns 0 for unknown models by design ("losing cost telemetry must never fail an extraction", `pricing.ts:41-42`), so switching without this silently books every sheet at $0.00. Do **not** copy `vlm_eval/pricing.py`'s $0.40/$2.40: applied to V1's measured 1,904 in / 7,459 out it predicts $0.0187 against a measured $0.0233 — about 20% light (derived). Fit the row to measured billing diffs over several runs; a first cut holding input at $0.40/M implies roughly **$3.0/M output** (derived from a single run — do not write it down on that alone).

**2c.** `server/src/pipeline/pipeline.service.ts:49,133-135` — band the sheet into thirds. `sharp` is already a dependency (`server/package.json:37`). Keep `SHEET_ENTRIES = 99` as the completeness check, add `const BAND_ROWS = 11;` (11 grid rows × 3 cols = 33 entries), and in `extract()` slice the decoded image into `ceil(gridRows / BAND_ROWS)` bands of `BAND_ROWS * 87` px, call `sheetPrompt(33, 3)` per band, offset each reply's `n` by `band * 33`, concatenate, and sum tokens/seconds into the single `Extraction` row so the cost telemetry stays one row per sheet. Compute band count from the actual image height, not from 99 — a short capture must not produce an empty third call.

Worth: **$0.1282 → $0.0264/sheet, saving $0.1018/sheet**, **$101.80 per 1000 sheets** (both derived from measured $/sheet). At an assumed 300 sheets/month — *an assumption, not a measured volume* — that is **$38.46 → $7.92, about $30.54/month**. Cost of it: **2 of 5 women leaked instead of 1 of 5.**

**Doing this server-side keeps it a one-repo change,** which is the reason to prefer it. Note what was actually measured, though: the 33-entry arms in this matrix were re-tiled to 2 columns at 436px (V2) and 1 column at 690px (V3), not 3 columns at native 345px. The native-345 3-column band was measured only under the older port prompt (`_r11`), where it also gave 2/5. **Buy the confirming run before shipping** — 3 nothinking calls, roughly $0.03 at the measured rate — rather than assuming the geometry transfers.

### 3. If you instead change the format on the client — that is a two-repo change and the halves must ship together.

If banding moves to the capture side (`snap-automation/src/snapclient/sheet.py:209-214` `build_sheet`, emitting three 33-entry images instead of one 99-entry montage, and/or changing `COLS`/`CELL_W`), then `SHEET_ENTRIES` and the `cols` argument to `sheetPrompt` in `pipeline.service.ts:49,134` must change in the same release. **Ship one half and every sheet is misread**: the server would ask for 99 entries, numbered in a 3-column reading order, over an image holding 33 in 2 columns. The model will comply with the prompt, not the picture, and the result is a well-formed reply that is wrong in a way nothing downstream detects. There is no version negotiation between the two repos today. Prefer 2c.

### 4. Silhouette fall-through — hold, and buy the key instead.

No edit to `normalize.ts` yet. The cheapest path to a decision is hand-keying the ~12 silhouette entries on the sheet behind `results/bakeoff_gemini-3.6-flash_live.json` and asking of those 12 alone: how many are men, how many are women. That is a human hour, not a model call, and it is the only thing that produces the number the change turns on.

## Known limits

- **Five women is the whole gender sample.** Every gender figure in this document is a count out of 5, deliberately never a percentage. The gap between "deployed" and "cheap + banded" is **one woman**. A sixth woman entering the corpus could reverse the recommendation, and no confidence interval on n=5 is worth printing.
- **Two women are unfixable by format.** `charlie_gafa` and `hehjwy20` are read `avatar=man` by both models in every arm here. No layout in this matrix touches them, and `ROUTING.md` reached the same conclusion by a different route.
- **Every cell above 345px is interpolation.** 345px is the native capture width. V2/V4 at 436/690px are `INTER_CUBIC` upsamples of the same pixels. A genuinely larger capture — more device pixels per avatar — **was not tested and cannot be tested without a client-side change.** What was refuted is "resampling up helps", which is what the harness could actually ask.
- **One run was discarded and re-bought.** The first nothinking-V2 attempt returned per-call billing deltas of +$0.2550, **−$0.1043**, +$0.0082; a negative delta means the gateway counter had not settled, and one call took 97.1s against a ~15s norm. It is kept at `results/fmt/run_gemini-3-flash-preview-nothinking_V2_attempt1.json` and is **not** in any table. The settle was raised 2s → 5s and that arm alone re-bought at $0.0264 on near-identical token counts (7,871 vs 8,681 out). The two samples agree on every gender outcome, so no accuracy conclusion rests on which you read. The $0.1589 is still spent and is counted in the $0.7413.
- **The $/sheet figures in the matrix are measured; almost everything else derived from them is marked.** They come from `pricing.balance_units()` diffs across serial calls, not from the API response — `/api/pricing` 404s as of 2026-08 and the balance endpoint is a single lifetime counter with no per-model breakdown, which is why nothing here was run in parallel. Per-1000 and per-month figures are arithmetic on those, and the monthly figure additionally assumes a sheet volume nobody measured.
- **Not measured, and it is the run I would buy next:** native 345px, 3 columns, 33 entries per image, live prompt, nothinking. That is the geometry recommendation 2c would actually ship, and its evidence is currently V2/V3 (different tiling) plus `_r11` (different prompt), which agree with each other at 2/5 but are not the thing itself. ~$0.03.
- **Nothing truncated, nothing salvaged.** All eight arms parsed to their full entry count, every reply well under the 32,000-token ceiling, `finish_reason` clean. The `_salvaged` path in `sheet_task.extract_json` did not fire.
- **The silhouette question has no measurement on any corpus on disk**, in either direction. The keyed 99 has no silhouette man; the sheet that has 12 of them has no key and no `skin_tone` field. The "0 men recovered / 0 women leaked" above is what the rule does on the key, and the key is the wrong corpus for it.
