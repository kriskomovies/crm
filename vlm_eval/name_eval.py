"""Can a free name dictionary replace the VLM's name_presents_as field?

`gender-guesser` is a pure-Python lookup over Joerg Michael's ~48k first-name
dictionary. No model, no network, no cost. If it reproduces the name-derived
gender signal, that field can leave the prompt -- and since the bill is ~76-98%
output tokens, dropping a key from the JSON is a direct saving.

WHAT THIS CAN AND CANNOT MEASURE. There is no key for name_presents_as, and
ground_truth.json deliberately refuses to have one: it is an inference about a
person, not a fact in the screenshot. What IS keyed is gender_presentation --
how the CARTOON is drawn. So this scores agreement between a name-derived guess
and the drawing, which is exactly the comparison the pipeline itself makes in
signalsDisagree(): when the two disagree the profile is held for review.

A high agreement rate means the free library carries the same signal the paid
field does. It does not mean either one is "right" about a person.

    D:\\ocr-venv\\Scripts\\python.exe name_eval.py
"""
import collections
import io
import json
import sys
import unicodedata
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
GT = HERE / "ground_truth.json"

# gender-guesser's six answers folded onto the pipeline's three.
FOLD = {
    "male": "man", "mostly_male": "man",
    "female": "woman", "mostly_female": "woman",
    "andy": "ambiguous",      # unisex
    "unknown": "ambiguous",   # not in the dictionary
}


def is_emoji(c):
    o = ord(c)
    return (unicodedata.category(c) == "So"
            or 0x1F000 <= o <= 0x1FAFF
            or 0x1F3FB <= o <= 0x1F3FF
            or o in (0x200D, 0xFE0F, 0x20E3))


def strip_emoji(s):
    s = unicodedata.normalize("NFKC", str(s or ""))
    return " ".join("".join(c for c in s if not is_emoji(c)).split())


def first_token(name):
    """The first alphabetic word of a display name, title-cased for the dict."""
    for tok in strip_emoji(name).split():
        word = "".join(c for c in tok if c.isalpha())
        if len(word) >= 2:
            return word.capitalize()
    return ""


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


def main():
    import gender_guesser.detector as gg

    det = gg.Detector(case_sensitive=False)
    people = roster()

    rows = []
    for r in people:
        tok = first_token(r["display_name"])
        raw = det.get_gender(tok) if tok else "unknown"
        rows.append({
            "handle": r["handle"],
            "name": strip_emoji(r["display_name"]),
            "token": tok,
            "raw": raw,
            "guess": FOLD.get(raw, "ambiguous"),
            "cartoon": r["gender_presentation"],
        })

    print("gender-guesser raw answers over 99 display names:")
    for k, n in collections.Counter(x["raw"] for x in rows).most_common():
        print(f"  {k:<16}{n:>4}")

    print("\nkeyed cartoon gender_presentation:")
    for k, n in collections.Counter(x["cartoon"] for x in rows).most_common():
        print(f"  {str(k):<16}{n:>4}")

    # Only entries where BOTH sides state a sex can agree or disagree; the
    # pipeline treats everything else as ambiguous and defers to the avatar.
    decisive = [x for x in rows
                if x["guess"] in ("man", "woman") and x["cartoon"] in ("man", "woman")]
    agree = [x for x in decisive if x["guess"] == x["cartoon"]]
    named = [x for x in rows if x["guess"] in ("man", "woman")]

    print(f"\nnames the dictionary would call a sex : {len(named)}/99")
    print(f"both sides decisive                   : {len(decisive)}/99")
    print(f"  agree with the cartoon              : {len(agree)}/{len(decisive)}"
          f"  ({len(agree) / max(1, len(decisive)):.0%})")
    print(f"  disagree -> pipeline holds for review: {len(decisive) - len(agree)}")

    print("\ndisagreements (these become review items, not follows):")
    for x in decisive:
        if x["guess"] != x["cartoon"]:
            print(f"  @{x['handle']:<20}{x['name']!r:<22} name says {x['guess']:<6}"
                  f" cartoon is {x['cartoon']}")

    unknown = [x for x in rows if x["raw"] == "unknown"]
    print(f"\n{len(unknown)} names not in the dictionary (-> ambiguous, avatar decides):")
    print("  " + ", ".join(sorted({x["token"] or "(none)" for x in unknown}))[:300])


if __name__ == "__main__":
    main()
