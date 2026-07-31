"""Head-to-head: where does a challenger differ from the reference run?

The leaderboard says 99/99 against 98/99 and that reads like a rounding error.
This shows the actual entries behind the gap, on all four fields at once, so the
question "is anything close to gemini-3.6-flash" gets answered with the rows
rather than with a scalar.

Entries are classified against the key, not against each other, because two
models differing is not interesting unless one of them is wrong.

    python compare.py sheet_gpt-4.1-mini_r11.json
    python compare.py sheet_gpt-5.4-mini_r11.json --ref sheet_gemini-3.6-flash_r11.json
"""
import argparse
import json
import sys
from pathlib import Path

import sheet
from score import norm_text, strip_emoji
from score_sheet import RESULTS, emoji_key, norm_handle

REF = "sheet_gemini-3.6-flash_r33.json"


def load(name):
    p = Path(name) if Path(name).exists() else RESULTS / name
    run = json.loads(p.read_text(encoding="utf-8"))
    return run, {e["n"]: e for e in run["entries"] if isinstance(e.get("n"), int)}


def fields(e, want):
    return {
        "handle": norm_handle(e.get("handle")) == norm_handle(want["handle"]),
        "name": (norm_text(strip_emoji(e.get("display_name")))
                 == norm_text(strip_emoji(want["display_name"]))),
        "emoji": emoji_key(e.get("display_name")) == emoji_key(want["display_name"]),
    }


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("challenger")
    ap.add_argument("--ref", default=REF)
    a = ap.parse_args(argv)

    roster = {r["n"]: r for r in sheet.roster()}
    ref_run, ref = load(a.ref)
    ch_run, ch = load(a.challenger)

    tally = {"ref_only": [], "ch_only": [], "both_wrong": []}
    for n, want in roster.items():
        rf, cf = fields(ref.get(n, {}), want), fields(ch.get(n, {}), want)
        for f in ("handle", "name", "emoji"):
            if rf[f] and not cf[f]:
                tally["ch_only"].append((n, f))
            elif cf[f] and not rf[f]:
                tally["ref_only"].append((n, f))
            elif not rf[f] and not cf[f]:
                tally["both_wrong"].append((n, f))

    print(f"reference  {ref_run['model']:<24} {ref_run.get('total_seconds')}s")
    print(f"challenger {ch_run['model']:<24} {ch_run.get('total_seconds')}s\n")

    def show(title, items):
        by_field = {}
        for n, f in items:
            by_field.setdefault(f, []).append(n)
        print(f"{title}: {len(items)}")
        for f, ns in sorted(by_field.items()):
            print(f"  {f:<7} {len(ns):>2}  {sorted(ns)}")

    show("challenger worse", tally["ch_only"])
    show("challenger better", tally["ref_only"])
    show("both wrong", tally["both_wrong"])

    hurt = sorted({n for n, f in tally["ch_only"]})
    if hurt:
        print("\nwhere the challenger loses:")
        for n in hurt:
            want, r, c = roster[n], ref.get(n, {}), ch.get(n, {})
            print(f"  {n:>3} key  {want['display_name']!r} / {want['handle']}")
            print(f"      ref  {r.get('display_name')!r} / {r.get('handle')}")
            print(f"      ch   {c.get('display_name')!r} / {c.get('handle')}")

    # Nationality has no key, so it is only ever reported as a difference.
    diff_nat = [n for n in roster
                if str(ref.get(n, {}).get("nationality", "")).casefold()
                != str(ch.get(n, {}).get("nationality", "")).casefold()]
    print(f"\nnationality differs on {len(diff_nat)}/99 (no key -- difference only)")
    for n in diff_nat[:15]:
        print(f"  {n:>3} {roster[n]['display_name'][:22]:<24}"
              f"ref {str(ref.get(n, {}).get('nationality'))[:12]:<14}"
              f"ch {ch.get(n, {}).get('nationality')}")


if __name__ == "__main__":
    main(sys.argv[1:])
