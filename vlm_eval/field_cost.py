"""What does each requested field cost, in output tokens?

APIMART.md's central finding is that the bill is 76-98% OUTPUT tokens -- cost is
governed by how much the model writes, not by how big the image is. So every key
removed from the JSON schema is a proportional saving, and the size of that
saving is arithmetic rather than opinion.

Measured over the real 99-entry roster, so the name/handle lengths are the actual
ones. Token counts are chars/4, the standard rough ratio: fine for a RATIO
between two schemas, which is all this is used for.

    D:\\ocr-venv\\Scripts\\python.exe field_cost.py
"""
import io
import json
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
GT = HERE / "ground_truth.json"

# Representative values, so per-field cost reflects what the model really writes.
FILLER = {
    "nationality": "English",
    "nationality_confidence": "low",
    "avatar_presents_as": "man",
    "name_presents_as": "man",
    "skin_tone": "light-tan",
}

CURRENT = ["n", "display_name", "handle", "nationality", "nationality_confidence",
           "avatar_presents_as", "name_presents_as", "skin_tone"]

# Three candidate schemas, in order of how much is proven.
#
# PIXELS_ONLY is the theoretical floor and is NOT reachable: it assumes skin
# tone moves to local code, and tone_eval.py measured that it cannot
# (Spearman -0.142, worse than always answering "light"). Kept only as the
# lower bound the other two are read against.
PIXELS_ONLY = ["n", "display_name", "handle", "avatar_presents_as"]

# PROVEN: only name_presents_as leaves, replaced by gender-guesser at 96%
# agreement with the keyed cartoon (name_eval.py). Nothing here is speculative.
PROVEN = ["n", "display_name", "handle", "nationality", "nationality_confidence",
          "avatar_presents_as", "skin_tone"]

# TARGET: also moves name origin to a local name->origin library. Untested here
# -- name_eval.py covered gender only -- so this is a plan, not a result.
TARGET = ["n", "display_name", "handle", "avatar_presents_as", "skin_tone"]


def roster():
    gt = json.loads(GT.read_text(encoding="utf-8"))["pages"]
    out, seen = [], set()
    for page in sorted(gt):
        for r in gt[page]:
            if r["handle"] in seen:
                continue
            seen.add(r["handle"])
            out.append(r)
    return out


def entry(r, n, fields):
    o = {}
    for f in fields:
        if f == "n":
            o["n"] = n
        elif f == "display_name":
            o["display_name"] = r["display_name"]
        elif f == "handle":
            o["handle"] = r["handle"]
        else:
            o[f] = FILLER[f]
    return o


def size(people, fields):
    body = json.dumps({"entries": [entry(r, i + 1, fields)
                                   for i, r in enumerate(people)]},
                      ensure_ascii=False)
    return len(body)


def main():
    people = roster()
    full = size(people, CURRENT)
    proven = size(people, PROVEN)
    target = size(people, TARGET)
    lean = size(people, PIXELS_ONLY)

    print(f"{'schema':<34}{'chars':>9}{'~tokens':>9}{'vs current':>12}")
    print("-" * 64)
    for label, n in (("current (8 keys)", full),
                     ("proven: -name_presents_as", proven),
                     ("target: also -origin/-conf", target),
                     ("floor: pixels only (unreachable)", lean)):
        delta = "—" if n == full else f"-{(1 - n / full):.0%}"
        print(f"{label:<34}{n:>9}{n // 4:>9}{delta:>12}")

    print(f"\nper-field cost of the four movable keys:")
    for f in ("nationality", "nationality_confidence", "name_presents_as", "skin_tone"):
        without = size(people, [x for x in CURRENT if x != f])
        print(f"  drop {f:<24}-{(1 - without / full):>5.1%}")

    # Output is ~98% of the bill on gemini-3.6-flash and ~76% on flash-lite.
    print("\napplied to the measured $/1000 (output-dominated, so ~linear):")
    print(f"  {'model':<24}{'now':>9}{'proven':>9}{'target':>9}")
    for model, price, out_share in (("gemini-3.6-flash", 0.735, 0.98),
                                    ("gpt-5.4-mini", 0.177, 0.90),
                                    ("gemini-2.5-flash-lite", 0.022, 0.76)):
        p = price - price * out_share * (1 - proven / full)
        t = price - price * out_share * (1 - target / full)
        print(f"  {model:<24}${price:>7.3f}  ${p:>7.3f}  ${t:>7.3f}")


if __name__ == "__main__":
    main()
