# Qwen2.5-VL 7B on the Quick Add screenshots

Run 2026-07-28. Ollama 0.32.5, `qwen2.5vl:7b` (8.3B params, Q4_K_M, 6.0 GB),
RTX 3070 Ti 8 GB — 100% on GPU at 7.8 GB VRAM, which fits with almost nothing to
spare. Scored against `ground_truth.json`: 122 rows over 9 pages, 99 unique
handles.

## Headline

**It can read the list.** Handles — the field this repo actually needs — come
back at 99.4% character accuracy, and one call per screenshot takes ~19s.

| over all 122 rows | page mode (1 call/screen) | row mode (14 calls/screen) |
|---|---|---|
| handle, exact | **117/122 (95.9%)** | 116/122 (95.1%) |
| handle, character accuracy | **99.4%** | 96.1% |
| display name text, exact | **119/122 (97.5%)** | 97/122 (79.5%) |
| display name text, char accuracy | **99.4%** | 87.0% |
| emoji in name, exact | 2/20 | 3/20 |
| rows missed | **0** | 5 |
| JSON parsed | 9/9 | 126/126 |
| wall clock, 9 pages | **168.6s** | 550.6s |

## Page mode beats row mode — use it

This was the opposite of what I expected. A 7B model asked to read fourteen rows
of ~20px UI text out of one 900×1600 image usually degrades badly against the
same model given one clean cropped row at a time, which is why both modes exist.

It does not degrade. Page mode is **better on every text metric and 3.3×
faster** — one call per screenful, 19s, nothing missed. Feeding it pre-cropped
rows actively hurt name transcription (79.5% vs 97.5% exact), most likely because
a single 660×100 strip strips away the context that tells the model how big the
text is and where a name ends.

The tradeoff is that page mode shrinks each avatar to ~60px, and the model stops
answering attribute questions about them almost entirely — see below.

Row mode does win on the *avatar attributes* — hair colour 57.4% vs 26.2%,
eyewear 65.6% vs 6.6% strict. So: **page mode to read the list, row mode if you
want per-avatar detail — and read the next section before trusting either.**

## The attribute scores are much weaker than they first look

This model **leaves an attribute blank rather than writing "none"**, and it does
so constantly. In page mode `facial_hair` came back empty on **all 122 rows**.

That matters because the obvious normalisation — treating `""` as `"none"` —
hands the model a correct mark on every clean-shaven face, and most faces here
are clean-shaven. My scorer did exactly that at first and reported
`facial_hair` at 79.5%, which was an artifact. Both readings, now reported side
by side:

| field | strict (blank = no answer) | lenient (blank = "none") | blanks |
|---|---|---|---|
| facial_hair, page | **0/122 (0%)** | 97/122 (79.5%) | 122 |
| facial_hair, row | **13/122 (10.7%)** | 105/122 (86.1%) | 98 |
| eyewear, page | **8/122 (6.6%)** | 79/122 (64.8%) | 107 |
| eyewear, row | **80/122 (65.6%)** | 99/122 (81.1%) | 20 |
| headwear, page | **37/122 (30.3%)** | 94/122 (77.0%) | 72 |
| headwear, row | **54/122 (44.3%)** | 79/122 (64.8%) | 29 |

Which is fair is a genuine judgement call, so pick deliberately rather than
letting a synonym table decide. The evidence for the lenient reading: on
`page_00` in row mode the model filled `facial_hair` on exactly the two rows
that have facial hair (Bsweezy, Marcas Ricci) and left the other twelve blank —
that is not random, it is "blank means nothing there".

The evidence against: it also blanks fields it plainly should have filled, like
`eyewear` on 107 of 122 rows in page mode, where many avatars visibly wear
glasses. It is declining because the 60px avatar is too small to resolve, not
because there is nothing there — and a blank that sometimes means "none" and
sometimes means "cannot see" is not a usable signal either way.

**Practical conclusion: do not use this model for avatar attributes.** Blank
dominates, page mode is close to useless for them, and even row mode only
reaches 65.6% on the best attribute field. Text is what it is good at.

The 4096-token default context did not truncate, even with a full screenshot and
14 rows of JSON out. Every one of the 135 calls across both modes returned
parseable JSON.

## Where it fails

**Emoji: 2/20.** The clear weakness. The model reads the *text* of a name
correctly and then drops the emoji entirely — `Balint🇦🇱🇦🇱🇦🇱` → `Balint`,
`Cammy🛵💨` → `Cammy`, `elijah 💫` → `elijah`. Occasionally it substitutes
(`dequan wallace🙌` → `dequan wallace👋`). If you key on display names, strip
emoji first; if you need them, this model will not give them to you.

**Handles: 5 misses in 122, all single-character.** The failure mode is specific
and worth knowing:

| truth | model | what happened |
|---|---|---|
| `sclarckson` | `sclarkson` | dropped a letter from an unusual spelling |
| `ryannn2233` | `ryann2233` | miscounted a run of three `n`s |
| `e1ijah_007` | `e1lijah_007` | inserted an `l` next to a `1` |
| `kadenm_o6` | `kadem_06` / `kadem_m06` | `o`/`0` confusion, failed twice |

Repeated letters and `l`/`1`/`o`/`0` are where it breaks. Note that
`sclarckson` → `sclarkson` is **the same error ChatGPT made** in the reference
table — the pull toward the common spelling is not unique to small models.

**Zero hallucinations.** The scorer flags four rows with no counterpart in the
key, which looks like invention and is not — every one is a real person read out
of a row clipped by a page edge, which `ground_truth.json` deliberately excludes:

| page | read as | actually |
|---|---|---|
| page_02 | `Landon` / `landn_morris` | real, keyed on page_01 |
| page_03 | `Josh Reed` / `josh_shinkyu` | real, keyed on page_02 |
| page_04 | `Sebastian` / `sea_bass013` | real, keyed on page_03 |
| page_08 | `Vinny$` / `vpannhurst` | real, and **not in the key at all** |

The last one is the interesting case: `vpannhurst` is a row every extraction
agent skipped as unreadable, and the model read it anyway. Across 122 rows and
nine pages it invented nothing.

## Skin tone: the number is misleading

Exact match is 19.7%, which reads like failure and is not. Scored by adjacency on
the tone scale, the model is **86% within one shade** and on `page_00` it was
100% within one shade. It is systematically one bucket cooler than the key
(`light` where the key says `light-tan`), which is a vocabulary calibration
offset, not blindness.

This is not fixable by prompting alone, because the key itself is not crisp here:
when two careful independent readers described all 122 rows, they disagreed on
`skin_tone` for 8 of the 99 handles. **Skin tone has a human disagreement floor
of roughly 8%**, so treat anything above ~90% as noise-limited and prefer the
within-one-shade number.

## The prompt mattered more than expected

The first run scored `hair_color` 21% and `skin_tone` 0%. Both were the prompt's
fault, not the model's:

- `hair_color` was in the requested JSON but never described in the rules, so the
  model returned `""`.
- The `placeholder` escape hatch was described before the normal answers, so the
  model applied it to almost every avatar.

Defining `hair_color` and demoting `placeholder` to a rare special case moved
those to 64% and (adjacency-corrected) 100% on `page_00`, with no model change.
The model also merged `headwear`/`eyewear` into one key until the rules said not
to. **Before concluding a local model is weak at something here, check whether
the prompt actually asked for it.**

## What this means for `read_usernames.py`

That script OCRs each row with Tesseract because uiautomator hides the text.
Tesseract is **not currently installed on this machine**, so there is no baseline
to compare against — the existing pipeline cannot run as written.

Qwen2.5-VL is a viable replacement on accuracy: 99.4% character accuracy on
handles, from one call per screen with no per-row cropping and no uiautomator
dependency for row geometry. The cost is latency — ~19s per screenful against
Tesseract's tens of milliseconds — and 7.8 GB of VRAM held while the emulator is
also running. For a scroll-and-scrape pass that is fine; for anything
interactive it is not.

The 5 handle misses are all one character. If handles must be exact, the cheap
fix is to reconcile against a second read rather than to trust a single pass.

## Reproducing

```bash
python run_eval.py --provider ollama:qwen2.5vl:7b --mode page --task both --pages all
```

```bash
python score.py
```

`python selftest.py` checks the scorer itself against known-answer cases (row
drops, hallucinations, reordering, emoji-vs-text) — run it after touching
`score.py`.
