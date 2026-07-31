"""Isolate the avatar-reading problem: is it the prompt, or the pixels?

`route_eval.py` found that `gemini-3.6-flash` reads `charlie_gafa` -- long hair,
eye makeup, lipstick -- as a man even when told explicitly to ignore the display
name. Two candidate causes, and they need separating before either is fixed:

  resolution  the avatar is ~70x70px inside the contact sheet, which may be too
              small to resolve eyelashes and lip colour at all
  prompt      the instruction leant on hair length, which is a weak Bitmoji
              signal -- short bobs and pixie cuts are common on female avatars

So this crops the avatars out, tiles them alone at a chosen scale, and asks only
the gender question. No transcription competing for attention, ~15x less output
than a full sheet run, so prompt variants cost cents to try.

Scored against `gender_presentation` in ground_truth.json, and the number that
matters is **women recalled**, never overall accuracy: 87 of 99 are men.

    python avatar_eval.py --scale 3 --prompt cues
    python avatar_eval.py --scale 1 --prompt plain     # the original wording
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np

import apimart
import pricing
import sheet
import sheet_task
from score_sheet import RESULTS, norm_handle

# The avatar disc inside a 345x87 cell, measured from the ink extent.
AV_X, AV_Y = (10, 84), (4, 86)
GRID_COLS = 9

PROMPTS = {
    # The wording route_eval.py was run with, kept so the comparison is real.
    "plain": """\
- presents_as: judge the drawn cartoon. One of "man", "woman", "ambiguous", \
"not-a-person". Look at hair length, eye makeup, lipstick, earrings, jewellery, \
facial hair and clothing.""",

    # Observation before judgement, and pointed at the cues Bitmoji actually
    # varies. Hair length is explicitly demoted -- it is what the plain prompt
    # leant on and it is the weakest signal in this art style.
    "cues": """\
- cues: FIRST, in 3-8 words, write what you actually see on this face: hair \
length and style, whether upper EYELASHES are drawn, whether the lips are full \
or coloured, eyebrow thickness and shape, earrings or jewellery, any facial \
hair, and the neckline. Describe before deciding.
- presents_as: THEN one of "man", "woman", "ambiguous", "not-a-person".

How this cartoon style encodes it -- read these in order:
1. EYELASHES are the strongest signal. Female avatars are drawn with visible \
upper lashes; male avatars have a plain lash line.
2. LIPS: fuller and/or coloured (pink, red, mauve) reads female; thin and \
uncoloured reads male.
3. EYEBROWS: thin and arched reads female; thick and straight reads male.
4. Facial hair is decisive for male.
5. HAIR LENGTH IS UNRELIABLE -- short bobs and pixie cuts are common on female \
avatars, and long hair occurs on male ones. Weigh it last, never first.
Do not assume a default and do not let the overall list bias you: judge each \
face on its own cues. If the cues genuinely conflict, answer "ambiguous".""",
}

HEAD = """\
This image is a grid of {n} cartoon avatars, {cols} columns wide, cropped from a \
social-media friend list.

READING ORDER IS CRITICAL: left to right across each row, then down to the next \
row. Entry 1 is top-left. Number them 1 to {n}.

For each one, describe how the CARTOON is drawn. These are drawings people chose \
for themselves, so this is a question about a picture, not a claim about anybody.

Return ONLY a JSON object, no prose and no markdown fence:
{{"entries": [{{"n": 1, {stub}}}, ...]}}

Emit exactly {n} entries.

Rules:
{rules}
- "not-a-person" if the avatar is not a human figure, or is a flat single-colour \
silhouette with no face."""


def build_grid(scale=3, cols=GRID_COLS):
    """Every avatar, cropped out and tiled, at `scale` times its native size."""
    img = sheet.load_sheet()
    tiles = []
    for n in range(1, sheet.N_ENTRIES + 1):
        i = n - 1
        r, c = divmod(i, sheet.COLS)
        cell = img[r * sheet.CELL_H:(r + 1) * sheet.CELL_H,
                   c * sheet.CELL_W:(c + 1) * sheet.CELL_W]
        av = cell[AV_Y[0]:AV_Y[1], AV_X[0]:AV_X[1]]
        tiles.append(cv2.resize(av, None, fx=scale, fy=scale,
                                interpolation=cv2.INTER_LANCZOS4))
    th, tw = tiles[0].shape[:2]
    rows = []
    for start in range(0, len(tiles), cols):
        chunk = tiles[start:start + cols]
        while len(chunk) < cols:                     # pad the last row
            chunk.append(np.full((th, tw, 3), 255, np.uint8))
        rows.append(np.hstack(chunk))
    return np.vstack(rows)


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gemini-3.6-flash")
    ap.add_argument("--scale", type=int, default=3)
    ap.add_argument("--prompt", choices=list(PROMPTS), default="cues")
    ap.add_argument("--cols", type=int, default=GRID_COLS)
    a = ap.parse_args(argv)

    grid = build_grid(a.scale, a.cols)
    stub = ('"cues": "...", "presents_as": "..."' if a.prompt == "cues"
            else '"presents_as": "..."')
    prompt = HEAD.format(n=sheet.N_ENTRIES, cols=a.cols, stub=stub,
                         rules=PROMPTS[a.prompt])

    print(f"{a.model}  prompt={a.prompt}  scale={a.scale}x  "
          f"grid {grid.shape[1]}x{grid.shape[0]}")
    m = apimart.Model(a.model)
    t0 = time.time()
    txt, meta = m.ask(prompt, [apimart.png_data_uri(grid)])
    got = sheet_task.entries_from(sheet_task.extract_json(txt))
    by_n = {}
    for i, e in enumerate(got):
        try:
            by_n[int(e["n"])] = e
        except (KeyError, TypeError, ValueError):
            by_n[i + 1] = e
    usd = pricing.cost(a.model, meta.get("prompt_tokens"),
                       meta.get("completion_tokens"))
    print(f"{time.time() - t0:.1f}s  {len(got)}/99 parsed  "
          f"in={meta.get('prompt_tokens')} out={meta.get('completion_tokens')}"
          + (f"  ${usd:.4f}" if usd else ""))

    gt = json.loads((Path(__file__).resolve().parent / "ground_truth.json")
                    .read_text(encoding="utf-8"))
    key = {}
    for page in sorted(gt["pages"]):
        for r in gt["pages"][page]:
            key.setdefault(norm_handle(r["handle"]),
                           (r.get("gender_presentation") or "").casefold())
    roster = sheet.roster()

    women = [r for r in roster if key.get(norm_handle(r["handle"])) == "woman"]
    men = [r for r in roster if key.get(norm_handle(r["handle"])) == "man"]

    def pred(r):
        return str(by_n.get(r["n"], {}).get("presents_as", "")).strip().casefold()

    w_ok = sum(1 for r in women if pred(r) == "woman")
    w_held = sum(1 for r in women if pred(r) != "man")
    m_ok = sum(1 for r in men if pred(r) == "man")
    print(f"\n  WOMEN called woman   {w_ok}/{len(women)}   "
          f"(not called man: {w_held}/{len(women)})")
    print(f"  men called man       {m_ok}/{len(men)}")

    # Did the model actually look? A model that emits the same description for
    # every face is filling in a template, not reading pixels -- and its labels
    # are then worthless however confident they look. Cheap models fail exactly
    # this way here, and without the cues field it is invisible: 99 answers of
    # "man" against an 88% male corpus looks like success.
    cues = [str(by_n.get(r["n"], {}).get("cues", "")).strip().casefold()
            for r in roster]
    seen = [c for c in cues if c]
    if seen:
        distinct = len(set(seen))
        top, n_top = max(((c, seen.count(c)) for c in set(seen)),
                         key=lambda x: x[1])
        print(f"\n  distinct descriptions {distinct}/{len(seen)}"
              + ("   <-- TEMPLATED, the model is not reading the images"
                 if distinct <= len(seen) * 0.25 else ""))
        if n_top > 3:
            print(f"  most repeated ({n_top}x): {top[:70]!r}")
    for r in women:
        c = by_n.get(r["n"], {}).get("cues", "")
        flag = "  " if pred(r) != "man" else "XX"
        print(f"  {flag} {r['n']:>3} {r['display_name'][:20]:<22}"
              f"{pred(r):<12}{str(c)[:52]}")

    out = RESULTS / f"avatars_{re.sub(r'[^A-Za-z0-9.-]+', '_', a.model)}" \
                    f"_{a.prompt}_x{a.scale}.json"
    RESULTS.mkdir(exist_ok=True)
    out.write_text(json.dumps({"model": a.model, "prompt": a.prompt,
                               "scale": a.scale, "meta": meta,
                               "entries": got}, indent=1, ensure_ascii=False),
                   encoding="utf-8")
    print(f"\n-> {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
