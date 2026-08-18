"""Per-field verdict on the golden sheet: where is the cheap model actually worse?

The switch decision has been argued on one field. It is not one decision -- the
two models are not uniformly better or worse than each other, and the fields
have different kinds of answer available:

  display_name, handle   transcription. Ground truth exists, so right/wrong.
  skin_tone              ground truth exists, and it is an ordinal scale, so
                         both exact agreement and within-one-bucket are
                         meaningful -- adjacent tones are a vocabulary being
                         finer than anyone can hold steady, not a mistake.
  nationality            no ground truth, and there cannot be one: nothing in a
                         screenshot establishes where a name comes from. Only
                         model-to-model agreement is available, plus the thing
                         that actually matters for routing -- how many land in
                         the anglophone bucket at all.

Emoji are stripped before comparing display names. A model that omits an emoji
the key records has not misread the name, and counting that as an error would
bury the real transcription failures under rendering noise.
"""
import json
import pathlib
import re
import unicodedata

HERE = pathlib.Path(__file__).resolve().parent
R = HERE / "results"
A_ID, B_ID = "gemini-3-flash-preview-nothinking", "gemini-3.6-flash"
TONES = ["pale", "light", "light-tan", "medium-tan", "tan", "brown", "dark-brown"]
ANGLO = {"english", "scottish", "welsh", "irish", "british", "american",
         "canadian", "australian"}


def strip_emoji(s):
    out = [c for c in (s or "")
           if unicodedata.category(c) not in ("So", "Sk", "Cf")]
    return re.sub(r"\s+", " ", "".join(out)).strip().lower()


def norm(s):
    return (s or "").strip().lower()


def main():
    import sheet
    gt_raw = json.loads((HERE / "ground_truth.json").read_text(encoding="utf-8"))
    gt = {}
    for page in sorted(gt_raw["pages"]):
        for r in gt_raw["pages"][page]:
            gt.setdefault(r["handle"].strip().lower(), r)
    roster = sheet.roster()

    runs = {}
    for mid in (A_ID, B_ID):
        d = json.loads((R / f"golden_{mid}.json").read_text(encoding="utf-8"))
        runs[mid] = {e["n"]: e for e in d["entries"]}

    stats = {}
    for mid, by_n in runs.items():
        name_ok = handle_ok = 0
        tone_exact = tone_near = tone_n = 0
        anglo = unknown = 0
        for r in roster:
            e = by_n.get(r["n"], {})
            key = gt.get(r["handle"].strip().lower(), {})
            if strip_emoji(e.get("display_name")) == strip_emoji(r["display_name"]):
                name_ok += 1
            if norm(e.get("handle")) == r["handle"].strip().lower():
                handle_ok += 1
            t_true, t_got = norm(key.get("skin_tone")), norm(e.get("skin_tone"))
            if t_true in TONES and t_got in TONES:
                tone_n += 1
                tone_exact += t_true == t_got
                tone_near += abs(TONES.index(t_true) - TONES.index(t_got)) <= 1
            nat = norm(e.get("nationality"))
            anglo += nat in ANGLO
            unknown += nat in ("", "unknown")
        stats[mid] = dict(name_ok=name_ok, handle_ok=handle_ok,
                          tone_exact=tone_exact, tone_near=tone_near,
                          tone_n=tone_n, anglo=anglo, unknown=unknown)

    nat_agree = sum(1 for r in roster
                    if norm(runs[A_ID].get(r["n"], {}).get("nationality"))
                    == norm(runs[B_ID].get(r["n"], {}).get("nationality")))

    n = len(roster)
    print(f"golden sheet, {n} entries, scored against the hand-keyed answer\n")
    print(f"{'field':<34}{'nothinking':>14}{'3.6-flash':>14}{'winner':>12}")
    print("-" * 74)

    def row(label, a, b, total, higher_better=True):
        win = "tie" if a == b else ("cheap" if (a > b) == higher_better
                                    else "3.6-flash")
        print(f"{label:<34}{f'{a}/{total}':>14}{f'{b}/{total}':>14}{win:>12}")

    sa, sb = stats[A_ID], stats[B_ID]
    row("display name exact", sa["name_ok"], sb["name_ok"], n)
    row("handle exact", sa["handle_ok"], sb["handle_ok"], n)
    row("skin tone exact", sa["tone_exact"], sb["tone_exact"], sa["tone_n"])
    row("skin tone within 1 bucket", sa["tone_near"], sb["tone_near"], sa["tone_n"])

    print(f"\nnationality has no ground truth and cannot have one.")
    print(f"  the two models agree on {nat_agree}/{n} "
          f"({nat_agree / n:.0%})")
    print(f"  in the anglophone bucket:  nothinking {sa['anglo']}/{n}   "
          f"3.6-flash {sb['anglo']}/{n}")
    print(f"  answered 'unknown':        nothinking {sa['unknown']}/{n}   "
          f"3.6-flash {sb['unknown']}/{n}")

    diff = [(r["display_name"], r["handle"],
             norm(runs[A_ID].get(r["n"], {}).get("nationality")),
             norm(runs[B_ID].get(r["n"], {}).get("nationality")))
            for r in roster
            if norm(runs[A_ID].get(r["n"], {}).get("nationality"))
            != norm(runs[B_ID].get(r["n"], {}).get("nationality"))]
    if diff:
        print(f"\n  where they differ ({len(diff)}):")
        for dn, h, a, b in diff:
            bucket = ("both in" if a in ANGLO and b in ANGLO else
                      "ROUTING DIFFERS" if (a in ANGLO) != (b in ANGLO)
                      else "neither in")
            print(f"    {(dn or '')[:20]:<22}{h[:18]:<20}{a:<12}{b:<12}{bucket}")


if __name__ == "__main__":
    main()
