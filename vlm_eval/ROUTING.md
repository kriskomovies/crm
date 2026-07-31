# Phase 0 — can the forward/hold decision be trusted?

The service forwards a profile when it **presents as a man** and its name reads as
one of a client's **target countries**. This measures that decision, not the
fields underneath it, because on this corpus the fields mislead:

> 87 of 99 profiles are men. A model that answers "man" for every row scores
> **88%**. Any headline accuracy number here is the base rate wearing a hat.

Reproduce with `python route_eval.py --run sheet_gemini-3.6-flash_r33_split.json`.

## Result

| | `gemini-3.6-flash` | `gemini-2.5-flash-lite` |
|---|--:|--:|
| forward precision | **100%** | 100% |
| forward recall | **100%** | **44%** |
| men still forwarded | 86/87 | 83/87 |
| women held back | 3/5 | 3/5 |
| $/1000 profiles | 0.74 | 0.022 |

**The country half works.** `gemini-3.6-flash` forwards exactly the 9 profiles
the 18-model reference panel says to forward, and nothing else. Three more
(`gluca256432`, `jaydenveilleu25`, `kaanan420`) it forwards on the panel's own
plurality where the panel itself was split 39–56% — those are genuinely
undecidable from a username, not model errors.

**The cheap model is not viable for this product.** `flash-lite` costs 33x less
and has perfect precision, but **44% recall** — it silently drops more than half
the leads a client asked for, because it flattens most origins to "American".
For a filter product that is not a saving, it is a broken filter. This closes the
cheap-first question the build plan left open: the escalation path is not worth
building, because the cheap path fails at the thing the product sells.

## The gender filter leaks, and prompt engineering did not fix it

First attempt asked for one combined `presents_as`. It forwarded 2 of the 5 women
in the corpus as men. The obvious diagnosis was that the male-coded name was
overriding the picture, so the prompt was split into two independently-judged
fields (`avatar_presents_as`, `name_presents_as`) with instructions to ignore the
other signal entirely, and routing set to hold any profile where they disagree.

That helped, but less than expected, and **the diagnosis was partly wrong**:

| profile | avatar says | name says | key | outcome |
|---|---|---|---|---|
| `kylee258082` Kylee Patterson | man | woman | woman | **caught** — disagreement → review |
| `charlie_gafa` Charlie Gafa | **man** | man | woman | still forwarded |
| `hehjwy20` Sif | **man** | ambiguous | woman | still forwarded |

Charlie Gafa's avatar has long hair, eye makeup and lipstick (`python zoom_cell.py
72 8` to see it). Told explicitly to ignore the name, the model *still* reads that
cartoon as a man. That is a vision error, not a name-override error, and no
prompt change fixes it. Sif is genuinely borderline — short hair, but earrings and
feminine features.

Splitting the fields is still the right design: it fixed one of three, it costs
nothing, and the disagreement signal is exactly what a review queue needs.

## What actually fixed it: ask about the avatars on their own

`avatar_eval.py` crops the avatars out of the sheet, tiles them alone, and asks
only the gender question. Three variables were tested separately:

| variant | women called woman | men correct | $/run |
|---|--:|--:|--:|
| in the full sheet, alongside transcription | **2/5** | 87/87 | — |
| avatars alone, same wording, native size | **4/5** | 87/87 | 0.029 |
| avatars alone, same wording, 3x upscale | 4/5 | 86/87 | 0.028 |
| avatars alone, cues-first wording, 3x | 4/5 | 86/87 | 0.053 |

**The prompt was not the problem and neither was resolution.** Upscaling 3x
changed nothing; rewriting the instruction to lead on eyelashes, lips and
eyebrows instead of hair length changed nothing. The one change that mattered was
**removing the transcription task from the same call** — 2/5 to 4/5, including
`charlie_gafa`, which the combined call got wrong every time. Reading 99 handles
character-perfect and judging 99 faces are apparently competing for the same
attention budget.

The remaining miss is `hehjwy20` "Sif", and its cues make it defensible rather
than wrong: *"short brown hair, plain lips, burgundy collar"*. No eyelashes, no
lip colour. The key says woman; the drawing genuinely supports "man or
ambiguous". Treat it as contested, not as a model error.

## Only `gemini-3.6-flash` can do this task at all

The cues field was added to make judgements auditable. It also caught the cheap
models fabricating:

| model | distinct descriptions | most-repeated | women found |
|---|--:|--:|--:|
| `gemini-3.6-flash` | **99/99** | 1x | 4/5 |
| `gemini-2.5-flash-lite` | 16/99 | **82x** | 0/5 |
| `gpt-4.1-mini` | **4/99** | **94x** | 0/5 |
| `gemini-2.5-flash` | 5/17 (truncated) | 13x | 0/5 |

`gpt-4.1-mini` emitted *the same sentence* — "short hair, no lashes, thin lips,
thick eyebrows" — for **94 of 99 different faces**. It is not looking at the
images; it is filling in a template and labelling everything "man". Against a
corpus that is 88% male that scores 86/87 on men and looks like success.

**This is why the cues field ships to production.** `distinct_cues / entries` is
a one-line guard that catches a model which has stopped reading the pixels, and
without it the failure is invisible — 99 confident answers, no error, no
exception, entirely fabricated.

## Cost of getting gender right

A second avatar-only pass is **$0.29 per 1000 profiles** on top of the $0.74
extraction, so ~$1.03/1000 all-in, and it moves women recall from 2/5 to 4/5.
Cheap models cannot substitute for it at any price, per the table above.

## What this means for the build

1. **Ship the country filter automatically.** 100/100 on the reference set, with
   panel-split cases surfaced rather than silently forwarded.
2. **Do not auto-forward on gender alone.** Expect roughly **2 in 5 women to slip
   through** at this sample size. Either route gender-risk profiles to human
   review, or tell clients the forward stream is ~5% wrong-gender and let them
   decide. Do not present it as clean.
3. **Use `gemini-3.6-flash`.** The 33x cheaper model loses 56% of the leads.
4. **The corpus cannot certify this.** Five women. Any rate computed on five is
   worth ±20 points — this run can catch a broken filter, not license a working
   one. Before clients rely on the gender gate, label ~150 profiles at roughly
   50/50 and re-run this script unchanged.

## What is and is not truly scored

- `avatar_presents_as` — scored against `gender_presentation` in
  `ground_truth.json`, keyed from the pixels. A real measurement.
- `nationality` — **has no key and cannot have one.** Scored against the
  18-model consensus in `results/nationality_consensus.json`, which is a
  reference, not a truth. A profile the panel splits on is reported as
  *undecided*, not as a model error.
- The forward decision — combines the real gender key with the consensus country.

Neither inference is a claim about the person behind the account: one describes a
cartoon they chose, the other a name they typed.
