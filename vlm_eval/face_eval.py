"""Score the two avatar fields the sheet prompt now asks for: facial_hair, bald.

    python face_eval.py                    # every run in results/
    python face_eval.py gemini-3.5         # only runs whose id contains this

WHY THIS IS NOT ONE ACCURACY NUMBER
-----------------------------------
78 of the 99 keyed faces are clean-shaven. A model that answers "none" for every
entry scores 79% and has read nothing -- the same trap ROUTING.md documented for
gender, where 87/99 men make "man" worth 88%. So the headline here is RECALL ON
THE 21 that actually have facial hair, and the false-positive count on the 78
that do not. Exact match is reported, but it is the least informative column.

BLANK IS NOT "none"
-------------------
RESULTS.md found qwen2.5-VL returning facial_hair empty on 122 of 122 rows, and a
scorer that read "" as "none" reported 79.5% -- an artifact of the base rate, not
a measurement. So a missing or empty value is counted as `blank` and never as an
answer. A model that declines to look must not score like one that looked and saw
nothing.

BALD HAS NO KEY
---------------
ground_truth.json has no bald field -- `hair_color` carries "not visible" and one
placeholder silhouette, which is not the same question. So bald is reported as a
distribution only: what each model claims, and how much the models agree with
each other. That is evidence about consistency, never about correctness. To score
it properly somebody has to label the 99 avatars first.
"""
import collections
import json
import re
import sys
from pathlib import Path

import sheet

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"

# The keyed vocabulary. Anything a model invents outside this is `other`, which
# is worth seeing rather than silently folding into the nearest bucket.
KEYED = {"none", "stubble", "moustache", "goatee", "beard",
         "beard+moustache", "moustache+goatee"}

# What models say when they mean the same thing. Kept deliberately small: an
# alias table is where a scorer starts flattering the model it scores.
ALIAS = {
    "mustache": "moustache",
    "mustache+goatee": "moustache+goatee",
    "beard+mustache": "beard+moustache",
    "moustache+beard": "beard+moustache",
    "full beard": "beard",
    "clean-shaven": "none",
    "clean shaven": "none",
    "no": "none",
    "": None,
}


def norm(v):
    """-> a keyed value, 'other', or None for blank/absent."""
    if v is None:
        return None
    s = str(v).strip().lower().replace("_", " ").replace(" + ", "+")
    s = re.sub(r"\s+", " ", s)
    s = ALIAS.get(s, s)
    if s is None or s == "":
        return None
    if s in KEYED:
        return s
    return "other:" + s[:24]


def truth():
    """handle -> keyed facial_hair, for the 99 unique entries."""
    gt = json.loads((HERE / "ground_truth.json").read_text(encoding="utf-8"))
    out = {}
    for page in gt["pages"].values():
        rows = page["rows"] if isinstance(page, dict) and "rows" in page else page
        for r in rows:
            h = (r.get("handle") or "").strip().lower()
            if h and h not in out:
                out[h] = norm(r.get("facial_hair"))
    return out


def score(run, key):
    """-> a row of counts for one run file."""
    got = {}
    for e in run.get("entries", []):
        h = (e.get("handle") or "").strip().lower()
        if h:
            got[h] = e
    # Scored on handles the model read correctly: a misread handle is a
    # transcription failure and is already counted by score_sheet.py. Charging
    # it again here would confuse two different things.
    common = [h for h in got if h in key]

    blank = exact = 0
    hit = miss = 0            # on the 21 that HAVE facial hair
    fp = 0                    # clean-shaven called hairy
    other = collections.Counter()
    bald = collections.Counter()

    for h in common:
        t = key[h]
        p = norm(got[h].get("facial_hair"))
        bald[str(got[h].get("bald", "(absent)")).strip().lower()] += 1
        if p is None:
            blank += 1
            continue
        if p.startswith("other:"):
            other[p[6:]] += 1
        if p == t:
            exact += 1
        t_has = t not in (None, "none")
        p_has = p not in (None, "none")
        if t_has and p_has:
            hit += 1
        elif t_has and not p_has:
            miss += 1
        elif not t_has and p_has:
            fp += 1

    answered = len(common) - blank
    return {
        "model": run.get("model", "?"),
        "mode": f"r{run.get('rows_per_call', '?')}",
        "n": len(common),
        "blank": blank,
        "answered": answered,
        "exact": exact,
        "hit": hit, "miss": miss, "fp": fp,
        "other": other,
        "bald": bald,
    }


def main(argv):
    key = truth()
    with_hair = sum(1 for v in key.values() if v not in (None, "none"))
    print(f"key: {len(key)} entries, {with_hair} with facial hair, "
          f"{len(key) - with_hair} clean-shaven "
          f"(always-'none' scores {100 * (len(key) - with_hair) / len(key):.0f}%)\n")

    rows = []
    for f in sorted(RESULTS.glob("sheet_*.json")):
        if argv and not any(a.lower() in f.name.lower() for a in argv):
            continue
        try:
            run = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if run.get("entries"):
            rows.append(score(run, key))

    if not rows:
        print("no runs matched")
        return

    # Recall on the 21 is the column that separates reading from guessing.
    rows.sort(key=lambda r: (-(r["hit"] / max(1, r["hit"] + r["miss"])), r["fp"]))
    print(f"{'model':<34}{'mode':>5}{'blank':>7}{'exact':>7}"
          f"{'recall(21)':>12}{'FP(78)':>8}")
    print("-" * 76)
    for r in rows:
        denom = r["hit"] + r["miss"]
        rec = f"{r['hit']}/{denom}" if denom else "-"
        pct = f" {100 * r['hit'] / denom:.0f}%" if denom else ""
        print(f"{r['model']:<34}{r['mode']:>5}{r['blank']:>7}{r['exact']:>7}"
              f"{rec + pct:>12}{r['fp']:>8}")

    print("\nbald -- NO KEY, distribution only (agreement, not correctness):")
    for r in rows:
        d = ", ".join(f"{k}={v}" for k, v in r["bald"].most_common(4))
        print(f"  {r['model']:<34} {d}")

    junk = [r for r in rows if r["other"]]
    if junk:
        print("\nvalues outside the keyed vocabulary:")
        for r in junk:
            print(f"  {r['model']:<34} "
                  + ", ".join(f"{k}x{v}" for k, v in r["other"].most_common(4)))


if __name__ == "__main__":
    main(sys.argv[1:])
