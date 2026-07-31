# Hosted models on the 99-entry contact sheet

Answers one question: **which model on the api.apimart.ai gateway reads the whole
Quick Add roster fastest, most accurately, and cheapest?** Input is
`../test/main/all99_3col.png` — all 99 entries as a 33x3 grid — and the required
output is `display_name`, `handle`, and a nationality guess for each.

Scored against `ground_truth.json`, which was keyed from the pixels. 40 runs over
21 models.

## The short version

`origin calls` is how many of the 99 the model was willing to call something
other than American or unknown, and `firm missed` is how many origins the
18-model panel agrees on that it flattened anyway. Neither is accuracy — that
field has no key — but together they separate a model that reads names from one
that types "American" 99 times. See
[Nationality](#nationality-is-not-scored-and-cannot-be).

| | model | handles | wall clock | $ / 1000 | origin calls | firm missed |
|---|---|---|---|---|---|---|
| **best value** | `gpt-5.4-mini --rows-per-call 11` | 98/99 | 59s | **0.177** | 22 | **0** |
| cheapest that is good | `gpt-4.1-mini --rows-per-call 11` | 98/99 | 65s | **0.090** | 17 | 1 |
| cheapest overall | `gemini-2.5-flash-lite --rows-per-call 11` | 98/99 | **17s** | **0.022** | 16 | 2 |
| fastest good one | `gemini-2.5-flash` | 98/99 | 41s | 0.267 | 24 | 0 |
| **best accuracy** | `gemini-3.6-flash` | **99/99** | 44–76s | 0.74 | 31 | 0 |
| also perfect | `gemini-3-pro-preview` | 99/99 | 37–93s | 0.72–1.78 | 24 | 0 |

**The last handle in 99 is expensive.** `gemini-3.6-flash` is the only model that
reads all 99 perfectly, and it costs **6x `gpt-5.4-mini` and 45x
`gemini-2.5-flash-lite`** to do it. Five models reach 98/99 for between $0.022 and
$0.267.

Nearly all of that premium is **output tokens, not capability**:

| model | output tokens for the same JSON | $/M out | share of cost |
|---|---|---|---|
| `gpt-4.1-mini` | 4,073 | 1.60 | 73% |
| `gemini-2.5-flash-lite` | 4,080 | 0.40 | 76% |
| `gemini-3.6-flash` | 15,343 | 8.58 | 95% |

`gemini-3.6-flash` emits ~3.7x the tokens at ~5x the rate for output that parses
to the same 99 objects — the difference is hidden reasoning. Cost here is
governed by how much a model thinks, not by how big the image is.

## What to actually run

- **Name and handle only** → `gemini-2.5-flash-lite --rows-per-call 11`. 98/99 in
  17 seconds for two cents per thousand. Nothing else is close on either axis.
- **Name, handle and a usable nationality** → `gpt-5.4-mini --rows-per-call 11`.
  Same 98/99, misses none of the origins the panel is firm about, at a sixth of
  the accuracy winner's price.
- **A wrong handle is unrecoverable downstream** → `gemini-3.6-flash`, and accept
  the 6x.

`gpt-4.1-mini` sits between the first two: as cheap as anything worth using
($0.090) and only one firm origin behind `gpt-5.4-mini`.

Full table: `python score_sheet.py`.

## How many entries per call? Sweep it, then stop at 98

Fewer entries per call helps enormously — but only for models that start weak,
and **nothing except `gemini-3.6-flash` gets past 98/99 at any band size.**

Handles exact, by entries per call:

| entries/call | calls | `gpt-5.1` | `gpt-5.2` | `gpt-4.1-mini` | `flash-lite` | `2.5-flash` | `3.6-flash` |
|--:|--:|--:|--:|--:|--:|--:|--:|
| 99 | 1 | 88 | 91 | 96 | 97 | **98** | **99** |
| 33 | 3 | 92 | 94 | **98** | **98** | 97 | **99** |
| 18 | 6 | 96 | 92 | — | — | — | — |
| 14 (raw pages) | 9 | **98** | 95 | **98** | **98** | — | **99** |
| 9 | 11 | **98–99** | 93 | **98** | **98** | **98** | — |

`gpt-5.1` gains eleven handles going from 99-per-call to 9-per-call, which is the
largest effect measured anywhere in this benchmark. `gpt-4.1-mini` and
`flash-lite` gain two and then flatten. `gpt-5.2` never converges — it wanders
91/94/92/93 with no trend, so its problem is not attention.

**The 98/99 wall is real and it is not one glyph.** Each model that reaches 98
stalls on a different ambiguous character, and no amount of banding moves it:

| model @ 9/call | its one remaining error |
|---|---|
| `gpt-4.1-mini` | `towmaterrrrrrr` — counts seven `r`s where there are eight |
| `gemini-2.5-flash-lite` | `kadenm_06` — reads lowercase `o` as digit `0` |
| `gemini-2.5-flash` | `kadenm_06` — same |
| `gpt-5.1` | `e11jah_007` — reads `i` as `1` (the key really is `e1ijah_007`) |

`o`/`0`, `i`/`1`/`l`, and counting a run of identical letters. `gemini-3.6-flash`
is the only model that clears all three, which is what the extra money buys.

`gpt-5.1` did produce one 99/99 at 9-per-call, but over three runs it scored
99, 98, 98 — so treat it as a 98 model that got lucky once, not a 99 model.

## Raw pages are worse value than the sheet

`../pages/*.png` are the original 900x1600 captures, 14 entries each. Tested
because fewer entries per call was helping — and it does help here too, lifting
`gpt-5.1` to 98/99 and holding `gemini-3.6-flash` at 99/99.

It is still the wrong thing to run, for a reason that has nothing to do with
accuracy: **the 9 pages overlap.** They are a scrolling capture, so 126 row-slots
cover only 99 accounts. You pay for 27% duplicate rows plus nine prompt copies:

| | `flash-lite` | `gpt-4.1-mini` | `gemini-3.6-flash` |
|---|---|---|---|
| contact sheet, 3 calls | 98/99 at **$0.022** | 98/99 at **$0.091** | 99/99 at $1.40 |
| raw pages, 9 calls | 98/99 at $0.046 | 98/99 at $0.153 | 99/99 at $2.78 |

Same accuracy, about double the money. The contact sheet already deduplicates the
scroll; that is the whole reason it exists.

### Why more calls costs more, when the data is identical

Not because there is more to read — the output is always the same 99 objects, and
output tokens barely move across modes. It is the **image being re-uploaded**, and
a smaller crop does not cost proportionally fewer tokens, because vision models
resize every image into a roughly fixed tile budget first.

`gemini-3.6-flash`, image tokens per call (`python image_tokens.py`):

| mode | calls | image size | Mpx | image tokens/call | input total | output total |
|---|--:|---|--:|--:|--:|--:|
| 1 call | 1 | 1035x2871 | 2.97 | 1100 | 1542 | 11276 |
| 3 calls | 3 | 1035x957 | 0.99 | 1088 | 4596 (3.0x) | 15343 |
| 9 pages | 9 | 660x1400 | 0.92 | 1056 | 12915 (8.4x) | 29945 |

A third of the sheet costs **1088 image tokens against 1100** for the whole thing.
Cutting the pixels by two thirds saves 1%. So N calls costs N times the input, and
for a reasoning model the output multiplies too, because it thinks afresh per call.

`gemini-2.5-flash-lite` is worse still — an 0.27 Mpx strip tokenises to the same
2838 as the entire 2.97 Mpx sheet, so its 11-call mode costs **11x** the input.
`gpt-4.1-mini` is the exception and does scale roughly with pixels (2923 -> 2038
-> 916 per call), which is why banding is cheap for it and dear for Gemini.

The practical consequence is a shift in what you are paying for. For
`flash-lite`, input is **16%** of the bill at one call and **54%** at nine:

| mode | input $ | output $ | $/1000 |
|---|--:|--:|--:|
| 1 call | 0.00033 | 0.00168 | 0.020 |
| 3 calls | 0.00052 | 0.00163 | 0.022 |
| 9 pages | 0.00243 | 0.00209 | 0.046 |

So split only as far as accuracy actually improves. Going from 1 call to 3 buys
`flash-lite` a handle for 10% more; going to 9 or 11 buys nothing and costs
2-3x.

### `ground_truth.json`'s `position` field cannot align page output

Worth recording because it produced a badly wrong answer first time round.
Scored positionally against the key, `gemini-3.6-flash` came out at 95/122 rows —
for a model that had read all 99 accounts correctly. Pages 05 and 08 were off by
one, every row on both.

The cause: `position` counts rows as the original extraction agents saw them,
including a clipped row at the top of the screen that `rows.py` crops away. On
`page_02` the offset to a crop row is 0; on `page_05` it is 1; nothing in the data
distinguishes them. `score_pages.py` therefore scores on the roster — how many
real accounts were read exactly, how many handles were invented, and whether each
page's accounts came back in increasing roster order — none of which needs a
position at all.

## Send the whole sheet in one call

All 99 entries in a single image is not too much to ask. Every competent model
returned exactly 99 numbered entries with no truncation and no duplicate numbers,
and splitting into 3 calls of 33 (`--rows-per-call 11`) **did not improve handle
accuracy on the models that were already good** — `gemini-2.5-flash` actually got
*worse* (98 -> 97). It costs 3x the image tokens because the prompt is re-sent
with every band.

Two exceptions where banding earns its keep:

- **emoji capture improves markedly**: `gemini-3.6-flash` went 88 -> 93/99 and
  `gpt-4.1-mini` 88 -> 91/99 on exact emoji codepoints. Small emoji are the one
  thing that genuinely benefits from more pixels per call.
- **weaker models gain a little**: `gemini-2.5-flash-lite` 97 -> 98,
  `gpt-4.1-mini` 96 -> 98.

This is the opposite of the finding for the local model in [RESULTS.md](RESULTS.md),
where cropping mattered a lot. Hosted frontier models do not need the help.

## The results are stable

Four runs each of the five finalists, same prompt, temperature 0:

| model | mode | handle exact, repeated runs | seconds |
|---|---|---|---|
| `gemini-3.6-flash` | 1 call | 99, 99, 99, 99, 99 | 44–76 |
| `gemini-3-pro-preview` | 1 call | 99, 99, 99, 99 | 37–93 |
| `gemini-2.5-flash` | 1 call | 98, 98, 98, 98 | 41–44 |
| `gpt-4.1-mini` | 3 calls | 98, 98, 98 | 56–65 |
| `gpt-5.4-mini` | 3 calls | 98, 98, 97 | 32–59 |
| `gemini-2.5-flash-lite` | 1 call | 97, 97, 97, 97 | 10.7–12.3 |
| `gpt-4.1-mini` | 1 call | 96, 96, 96, 94 | 50–59 |

The Gemini runs are effectively deterministic — `gemini-2.5-flash` returned byte
identical token counts all four times. Latency varies more than accuracy does.
Note the two `gpt-4.1-mini` rows: banding does not just raise its score, it
**stabilises** it, turning 96/96/96/94 into 98/98/98.

## Is anything close to `gemini-3.6-flash`?

On transcription, yes. On the inference field, no. Both in 3-call mode,
`compare.py` against the same key:

| | `gemini-3.6-flash` | `gpt-4.1-mini` | `gpt-5.4-mini` |
|---|---|---|---|
| handles | **99/99** (5/5 runs) | 98/99 (3/3 runs) | 98/98/97 |
| names | **99/99** | 97/99 | 97/99 |
| emoji | **96/99** | 91/99 | 92/99 |
| origin calls | **31** | 18 | 21 |
| firm origins missed | **0** | 1 | **0** |
| $ / 1000 | 1.00–1.40 | **0.091** | 0.176 |

Head to head `gemini-3.6-flash` wins 9 field-comparisons to 1. The whole
transcription gap is three entries: `towmaterrrrrrrr` (gpt-4.1-mini counts seven
`r`s, not eight), `Rinku Koyalkar` -> `Kovalkar`, and the stylised `🄳🅈🄻🄰🄽`.

The nationality gap is wider and does not close with banding. On the 19 entries
where the two differ, `gpt-4.1-mini` answers "American" for names the panel reads
as Danish (`Charles Nielsen`), English (`Sam Clarckson`), Italian
(`Marcas Ricci`), Spanish (`Efren`, `liam garcia`), Irish (`connor`), French
(`Jack Turmel`), Maltese (`Charlie Gafa`) and Portuguese (`Ryan Arruda`).

One oddity worth knowing: **`gpt-4.1` (full) is the best model tested at the
nationality field** — 33 origin calls, none of the firm ones missed, more than
`gemini-3.6-flash` — while being one of the *worst* of the good models at
actually reading the handles (93/99) and costing $0.411. Reading and inferring
are not the same skill and do not rank together.

## What the residual errors are

Two entries account for nearly every remaining miss on the good models, and both
are the same glyph pair:

| entry | key | what the cheap models said |
|---|---|---|
| 92 | `kadenm_o6` | `kadenm_06` |
| 94 | `benlottablockz0` | `benlottablockzo` |

Lowercase `o` against digit `0`, misread in **both directions**. In this font the
distinction is purely height — `o` is 9px x-height, `0` is 13px full height —
which survives at a zoom no model is being given. `zoom_cell.py` and a glyph-height
measurement settle these by eye; nothing else does.

The other recurring miss is `Sam Clarckson` / `sclarckson`, which four models
"corrected" to the more common `Clarkson`. That trap is documented in
[table_audit.md](table_audit.md) and it is still catching models.

**One error was ours, not the models'.** Seven models independently read entry 38's
handle as `towmaterrrrrrrr`; the key said `towmaterrrrrrr`. Counting connected ink
runs in the handle line gives 15 glyphs — `towmate` plus **eight** `r` glyphs — so
the models were right and `ground_truth.json` has been corrected. When several
independent models agree against a hand-keyed answer, check the key first.

## Two failure modes worth recognising

**`gpt-4o-mini` silently drops entries and renumbers anyway** — 3/99 positionally,
but 57/99 handles present *somewhere*. It reads down the list omitting rows and
still emits a confident 1..99. It is not reading column-major (1/99 against that
hypothesis); it is just skipping. It also spent **48,602 input tokens** on this
image, 30x what Gemini spends, because of how it tiles. Unusable here at any price.

**`claude-haiku-4-5` confabulates handles that look right** — 95/99 display names
but 55/99 handles, with ordering perfect and zero misplacement. Its errors read as
plausible guesses derived from the name rather than misreadings of pixels:
`bsouthwick73` -> `bsweetweck73`, `xxmjrchaosxx22` -> `symphchassx22`,
`kevinabruno` -> `kevinsbruno`. Large black display text it reads; small grey
handle text it invents. That is the most dangerous shape of error here, because
nothing downstream looks wrong.

`gpt-5.4-nano` fails a third way — it both misreads and misplaces (56/99, 12
misplaced). `gemini-3.1-flash-lite-preview` never answered at all: the gateway
returned HTTP 500 "please wait and try again later" on every attempt.

## The cascade does not pay

The obvious way to avoid paying for the expensive model is to run two cheap ones,
accept where they agree, and escalate only the disagreements. Measured, that is
**strictly worse than just buying the accurate model**:

```
cascade (flash-lite + 2.5-flash, gemini-3.6-flash arbitrates)  98/99   $1.286 / 1k
gemini-3.6-flash alone                                          99/99   $1.000 / 1k
```

The reason is in `cascade.py`'s output: the two cheap models disagree on exactly
**one** entry in 99, and the error they both make — entry 92's `o`/`0` — they make
*identically*. Agreement between two models with the same failure mode is not
evidence. The escalation fires too rarely to help, and the arbiter is billed for
a whole sheet regardless, since it is one call over one image.

Run it yourself: `python cascade.py`.

## Nationality is not scored, and cannot be

The third requested field is an inference. Nothing in a screenshot establishes
anyone's nationality — a display name and a username are weak evidence about a
person, and treating a model's guess as a fact about them would be wrong
regardless of how confident the model sounds. So there is no key for it and no
accuracy number.

What is reported instead is **agreement across 16 models**, in
`roster_with_nationality.csv`:

- 79/99 entries at >=80% agreement
- 11 entries genuinely split, e.g. `Jack Turmel` (american 9 / french 7),
  `Ryan Arruda` (portuguese 9 / american 7), `Charlie Gafa` (american 8 / maltese 7)

High-agreement non-English reads are the ones that look defensible —
`Balint Szabo` -> Hungarian (16/16), `Rinku Koyalkar` -> Indian (16/16),
`tim hüttner` -> German (94%), `matteo sotgiu` -> Italian (94%),
`Kurt Bey` -> Turkish (16/16, and that display name does carry a 🇹🇷).

Read the `agreement` column as the actual output. Anything under 0.7 means the
models disagreed and there is no answer, only a plurality.

**The cheap model is much weaker at this than at transcription, and banding fixes
most of it.** Asked for all 99 at once, `gemini-2.5-flash-lite` makes only **5**
non-American calls in 99 and defaults everything else to "American" — missing
five origins the 16-model consensus is firm about, including `Lorenzo Piceno`
(italian, 94%) and `Yared` (ethiopian, 88%). Split into 3 calls of 33 it makes
**16** and misses only two. `gemini-3.6-flash` makes 30 and misses none.

| run | non-American calls | matches consensus | firm origins missed |
|---|---|---|---|
| `flash-lite`, 1 call | 5 | 84/99 | 5 |
| `flash-lite`, 3 calls | 16 | 88/99 | 2 |
| `gemini-3.6-flash`, 1 call | 30 | 87/99 | 0 |

So the mode to run depends on which field you care about. Transcription is
equally good either way; **if the nationality column matters, use
`--rows-per-call 11`** — it costs $0.022 instead of $0.020 and 17s instead of 11s.
Attention per entry, not capability, is what is short in the single-call mode.

### Which models agree with `gemini-3.6-flash` here

`nat_compare.py` puts every model's origin calls beside the reference's. Note
what this does and does not mean: there is no key, so agreement is agreement, not
correctness — the reference may simply be over-calling.

| model | handles | $/1000 | agrees | flattened | genuinely differs |
|---|--:|--:|--:|--:|--:|
| `gemini-3.5-flash` | 97/99 | 0.991 | **92/99** | 3 | 4 |
| `gemini-2.5-flash` | 98/99 | **0.267** | 88/99 | 6 | 5 |
| `gemini-3-pro-preview` | 99/99 | 1.682 | 88/99 | 6 | 5 |
| `kimi-k2.5` | 93/99 | **0.050** | 87/99 | 6 | 5 |
| `gpt-5.4-mini` | 98/99 | 0.176 | 85/99 | 9 | 5 |
| `gemini-2.5-flash-lite` | 98/99 | 0.022 | 80/99 | **15** | 3 |
| `gpt-4.1-mini` | 98/99 | 0.107 | 79/99 | **17** | 3 |

Where the closest model differs it is on genuinely contested names — `Stefi`
(greek vs italian), `Gabriel Luca` (romanian vs italian), `AJ` and `Tj`
(american vs unknown) — not on anything clear-cut.

**The two skills are anti-correlated at the cheap end.** The best-value
transcribers, `gemini-2.5-flash-lite` and `gpt-4.1-mini`, are the *worst* at
origins (15 and 17 flattened). Meanwhile `kimi-k2.5` agrees 87/99 at **$0.050**
while reading only 93/99 handles. No single cheap model is good at both.

### So split the roles

Since transcription and inference are separate skills with separate leaders,
running two cheap models beats running one expensive one:

| plan | handles | origin agreement | $/1000 |
|---|--:|--:|--:|
| `gemini-3.6-flash` alone | **99/99** | reference | 1.00 |
| `flash-lite` (names) + `kimi-k2.5` (origins) | 98/99 | 87/99 | **0.072** |
| `gemini-2.5-flash` alone | 98/99 | 88/99 | 0.267 |

Fourteen times cheaper than the reference for one handle and a handful of origin
calls. Note this is the opposite conclusion from
[the cascade](#the-cascade-does-not-pay) — and for a clear reason. A cascade runs
two models at the *same* task hoping disagreement finds errors, which fails
because they share failure modes. This runs two models at *different* tasks,
each where it is strongest, and there is no shared failure mode to defeat it.

The prompt deliberately asks what origin *the name reads as* rather than what
nationality the person *is*. Asked the second way, models answer confidently
about strangers; asked the first way, they use "unknown" for the entries that are
just digits.

## Cost, and one price the gateway does not publish

The gateway is one-api shaped: `/api/pricing` gives ratios, not dollars, at
$2 per million tokens per unit of ratio.

```
input  $/M = model_ratio * 2
output $/M = model_ratio * completion_ratio * 2
```

Verified against models whose real prices are known — `gpt-4o-mini` comes out
$0.15/$0.60 and `claude-sonnet-4-6` $3/$15, both correct.

**`gemini-3.6-flash` publishes `model_ratio: 0`, which means unlisted, not free.**

It was priced twice, and the first attempt was wrong in a way worth recording.
`measure_cost.py` ran the model alone and diffed the balance endpoint, whose unit
had itself to be calibrated against a second model (`gemini-2.5-flash`: 8.4480
units against a predicted $0.1056, so 80.01 units per dollar). Two estimates
compounded, and the result — $1.43/M in, $8.58/M out — came out **~35% high**.

`solve_price.py` instead solves against the gateway's own per-model spend panel,
which is a single observed number with no intermediate calibration: **$0.66
across 13 calls**, of which 12 are accounted for at 18,423 input and 104,522
output tokens.

```
$1.02 /M input,  $6.13 /M output
```

Output is 98% of the bill, so the input/output split assumption barely matters —
solving on output alone gives $6.31/M, 2.9% away.

That puts a **single-call pass over 99 profiles at $0.071, i.e. $0.72–0.75 per
1000** — not the $1.00 first reported. It is still 33x `gemini-2.5-flash-lite`,
so nothing about the recommendation changes, but the multiple was overstated.

Dividing the $0.66 by 13 calls would have given a different and meaningless
answer: those 13 calls were four separate experiments with output sizes from
1.4k to 12k tokens, and cost here is ~98% output tokens. Tokens are the only
sound denominator.

## Gateway quirks

- **It always streams.** `/v1/chat/completions` answers `text/event-stream`
  whether or not `"stream": true` was sent, so the reply must be reassembled from
  SSE `data:` chunks. Parsing the body as one JSON object fails on every model —
  which is what it looks like when 29 of 29 models "fail" at once.
- Usage totals arrive in the final chunk, including `image_tokens`.
- Reasoning models reject `temperature`; `apimart.Model` learns that from the
  error text and retries without it rather than withholding it from everyone.
- HTTP 500 "please wait and try again later" is a gateway capacity message, not a
  model error.

## Files

| file | does |
|---|---|
| `sheet.py` | grid geometry for the contact sheet, and the 99-entry roster |
| `sheet_task.py` | the prompt, and the JSON extractor with truncation salvage |
| `apimart.py` | gateway client: SSE parsing, per-model parameter quirks |
| `pricing.py` | ratio -> dollars, plus measured prices for unlisted models |
| `probe.py` | cheap triage — 6 entries against many models at once |
| `run_sheet.py` | the runs; writes one file per model as it finishes |
| `score_sheet.py` | scoring, positional and as-a-set, plus nationality consensus |
| `mistakes.py` | every miss, key beside prediction; `--all` ranks by frequency |
| `cascade.py` | the two-cheap-models-plus-arbiter analysis |
| `measure_cost.py` | real cost by billing delta |
| `zoom_cell.py` | blow up one entry to settle a disputed glyph |
| `roster_out.py` | the deliverable: `roster_with_nationality.csv` / `.md` |

## Running it

The key lives in `.apimart_key` (gitignored) or `$APIMART_KEY`.

```bash
python probe.py
```

```bash
python run_sheet.py --models gemini-2.5-flash-lite gemini-3.6-flash
```

```bash
python score_sheet.py
```

```bash
python roster_out.py
```
