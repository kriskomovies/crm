"""If we only act on "man", how clean is that bucket?

route_eval.py asks the recall question -- of the women, how many were held back.
That is the right question when the cost is "a woman gets forwarded to a client
who asked for men". But if the product simply ignores everything not labelled
"man", the number that decides quality is **precision**: of everything the model
put in the man bucket, how much of it is actually a man?

The two come apart sharply here. Missing a man costs one lead out of thousands.
Putting a woman in the man bucket sends the wrong person to a paying client. So
this reports:

  strict precision   of the man bucket, the share the pixel key calls "man"
  hard-error rate    of the man bucket, the share the key calls "woman" -- the
                     only errors that are unambiguously wrong, since the key's
                     "ambiguous" means the CARTOON is unreadable and such a
                     profile may well be a man

And because the live rule is "man AND country in set", it sweeps every country
in the corpus to show that forward precision depends on which countries a client
picks -- a misread woman only reaches a client if her name's origin is on their
list.

    python precision_eval.py
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import sheet
from score_sheet import RESULTS, norm_handle

GT = Path(__file__).resolve().parent / "ground_truth.json"

RUNS = [
    ("full sheet, combined field", "sheet_gemini-3.6-flash_r33_gender.json",
     "presents_as"),
    ("full sheet, split fields", "sheet_gemini-3.6-flash_r33_split.json",
     "avatar_presents_as"),
    ("avatars alone", "avatars_gemini-3.6-flash_plain_x1.json", "presents_as"),
    ("avatars alone, cues", "avatars_gemini-3.6-flash_cues_x3.json",
     "presents_as"),
]


def gender_key():
    gt = json.loads(GT.read_text(encoding="utf-8"))
    out = {}
    for page in sorted(gt["pages"]):
        for r in gt["pages"][page]:
            out.setdefault(norm_handle(r["handle"]),
                           (r.get("gender_presentation") or "").casefold())
    return out


def load(fname, roster):
    p = RESULTS / fname
    if not p.exists():
        return None
    d = json.loads(p.read_text(encoding="utf-8"))
    entries = d.get("entries", [])
    by_n = {}
    for i, e in enumerate(entries):
        try:
            by_n[int(e["n"])] = e
        except (KeyError, TypeError, ValueError):
            by_n[i + 1] = e
    # Avatar runs are keyed by grid position, sheet runs by entry number; both
    # are roster order, so position -> handle is the same mapping.
    return {r["handle"]: by_n.get(r["n"], {}) for r in roster}


def main(argv):
    roster = sheet.roster()
    key = gender_key()

    print(f"{'run':<30}{'man bucket':>12}{'actually men':>14}"
          f"{'strict prec':>13}{'women in it':>13}{'hard err':>10}")
    print("-" * 92)
    keep = {}
    for label, fname, field in RUNS:
        got = load(fname, roster)
        if got is None:
            print(f"{label:<30}  (missing {fname})")
            continue
        bucket = [r for r in roster
                  if str(got[r["handle"]].get(field, "")).strip().casefold() == "man"]
        truths = [key.get(norm_handle(r["handle"]), "") for r in bucket]
        men = sum(1 for t in truths if t == "man")
        women = sum(1 for t in truths if t == "woman")
        prec = men / len(bucket) if bucket else 0
        hard = women / len(bucket) if bucket else 0
        print(f"{label:<30}{len(bucket):>12}{men:>14}{prec:>12.1%}"
              f"{women:>13}{hard:>10.1%}")
        keep[label] = (got, field, bucket)

    print("\nstrict prec = share of the man bucket the pixel key calls 'man'.")
    print("The gap to 100% is mostly the key's 'ambiguous' -- an unreadable")
    print("cartoon, which may well be a man. 'hard err' is the share that are")
    print("women, and that is the only unambiguously wrong outcome.")

    # ---- does the country filter clean it up, or is that luck? -------------
    label = "full sheet, combined field"
    if label not in keep:
        return
    got, field, _ = keep[label]
    by_country = defaultdict(lambda: {"man": 0, "woman": 0, "other": 0})
    for r in roster:
        e = got[r["handle"]]
        if str(e.get(field, "")).strip().casefold() != "man":
            continue
        nat = str(e.get("nationality", "")).strip().casefold() or "(none)"
        t = key.get(norm_handle(r["handle"]), "")
        by_country[nat]["man" if t == "man" else
                        "woman" if t == "woman" else "other"] += 1

    print(f"\nthe man bucket, split by the country the model assigned:")
    print(f"  {'country':<16}{'forwarded':>10}{'men':>6}{'women':>7}{'other':>7}")
    for nat, c in sorted(by_country.items(), key=lambda kv: -sum(kv[1].values())):
        tot = sum(c.values())
        flag = "   <-- contains a woman" if c["woman"] else ""
        print(f"  {nat:<16}{tot:>10}{c['man']:>6}{c['woman']:>7}{c['other']:>7}{flag}")

    dirty = [n for n, c in by_country.items() if c["woman"]]
    print(f"\nA client whose target list includes {dirty} receives a woman.")
    print("A client targeting anything else does not. Forward precision is")
    print("therefore a property of the client's country list, not of the")
    print("pipeline -- so it has to be measured per tenant, not once.")


if __name__ == "__main__":
    main(sys.argv[1:])
