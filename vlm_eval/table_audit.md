# Audit of the ChatGPT reference table

The table describes the 14 rows of `pages/page_00.png` and was going to be used
as the scoring key for a local model. Before spending GPU time on that, it was
checked against the pixels.

Method: three independent transcription passes and three lens-specific attribute
passes over the same screenshot, plus direct inspection at 4–16× zoom
(`zoom.py`, `zoom_text.py`, `montage.py`), plus an adversarial audit pass. All
three transcription passes agreed with each other and with the hand read on all
14 rows.

## Score

Scored like any other run (`results/chatgpt-reference_page_read+avatar.json`):

| field | result |
|---|---|
| display name, emoji stripped | **12/14 exact**, 95.8% character accuracy |
| display name, emoji included | 10/14 exact |
| emoji codepoints | **0/3 rows correct** |
| facial hair | **14/14** |
| skin tone | 11/14 |

## Where it is wrong

**Four hard errors, all in the objectively checkable columns.**

1. **Row 9 — `Sam Clarkson` should be `Sam Clarckson`.** There is a clear `c`
   between the `r` and the `k`, and the handle underneath reads `sclarckson`,
   corroborating it. The table silently normalised an unusual surname to the
   common one — then reasoned about "English surname; U.K./U.S./Aus" from the
   corrected spelling.

2. **Row 8 — the Turkish flag is missing.** The name renders as `Kurt Bey🦊🇹🇷`:
   fox face, then the flag of Turkey. The table records only the fox. Its
   origin cell then speculates that *"Bey* can be Turkish" — guessing at
   something the image states outright.

3. **Row 10 — wrong emoji, and half of them dropped.** The table has
   "(runner + football) Marcas Ricci". The image shows `🤼🏈Marcas Ricci🏈🤼`:
   two figures grappling (one orange singlet, one green), not a runner, and the
   pair is mirrored *after* the name as well.

4. **Row 13 — the crystal ball is missing.** The name is five boxed capitals
   spelling DYLAN followed by 🔮. The table stops at `D Y L A N`.

A fifth factual slip: the table's row-6 note calls `Bsweezy` a "handle only".
`Bsweezy` is the display name; the handle is `bsouthwick73`.

**And the single most checkable field is absent.** There is no handle column at
all — yet every row renders one, and several diverge completely from the display
name (`Nakoah Farris`→`xxmjrchaosxx22`, `Bsweezy`→`bsouthwick73`,
`Kurt Bey`→`y1302420`, `Marcas Ricci`→`beastboyzz34`, `Efren`→`ohnobro9000`).
That is exactly where a weak model fails, and the table cannot see it.

The practical consequence: **a model that reads `Sam Clarckson` correctly would be
marked wrong.** On the four hardest rows the key inverts the ranking.

## Where it is right

Better than expected, and worth saying plainly — several claims that looked like
errors survived checking:

- **Row 7, "deep red avatar tint" — correct.** The whole avatar really is flat
  monochrome brick red: hair, face, glasses and shirt alike. It is not red hair
  on light skin.
- **Row 11, "eyes covered by spa cucumbers" — correct.** They are literal
  cucumber slices, not green goggles.
- **Row 10, "moustache & small goatee" — exactly right**, including the soul
  patch that is easy to mistake for the spiked collar beneath it.
- **Facial hair overall: 14/14.** Twelve clean-shaven, row 6 moustache, row 10
  moustache + goatee. Perfect.

## Two columns that cannot be scored at all

**Name-origin best guess.** Nothing in a screenshot establishes the etymology of
a name or the nationality, ethnicity or heritage of an account holder. It is
external speculation layered on a string, not a reading of the image — so it
cannot be marked right or wrong, and a model that declines to guess would be
penalised for correct behaviour. It is also demographic inference about real
people from usernames, which is not a perception task and is not something the
eval should train anyone to optimise.

**Likely gender.** The column reports avatar presentation as a fact about a
person. The image shows a cartoon chosen in an avatar editor. It is also
constant — "man" ×14 — so it has zero power to separate a good model from a bad
one. `ground_truth.json` replaces it with `gender_presentation`, which describes
the drawing and is checkable.

**Skin tone sits in between** and needs care. The coarse light/tan/dark bucket is
real — row 5 is visibly darker than the rest — but the table's own vocabulary is
not self-consistent: it puts the *hair* colour "blond" in row 3's skin cell,
calls two faces "light-olive" that sit inside its own "light" cluster, and has no
bucket for row 7's monochrome render.

That is not just a flaw in this table. When two careful independent readers
described all 122 rows across the nine pages, they disagreed on `skin_tone` for
eight handles (`hunterioa`, `npaxos11`, `lucascamp01`, `julevinc`, `kadenm_o6`,
`viknotactive`, `jesse.james0`, `dylan91193`) — usually light vs light-tan.
**Skin tone has a disagreement floor of roughly 8% between careful humans**, so a
model scoring in the low 90s on it is at the noise ceiling, not failing.

## Verdict

Not usable as a scoring key as supplied. `ground_truth.json` was built from the
pixels instead, keeping the columns that can be checked, adding the handle
column, and dropping the two that cannot.

Grade a model on **handle** and **display-name text** first. Those are objective,
they are where models actually fail, and they are the fields this repo needs.
