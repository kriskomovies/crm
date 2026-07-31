"""Would two cheap models plus an escalation beat one expensive one?

The leaderboard's top and bottom differ by 2 entries in 99 and by 50x in price,
which makes "just buy the accurate model" a weak conclusion. The alternative is
a cascade: read the sheet with two cheap models, accept the entries where they
agree, and spend the expensive model only on the handful where they do not.

What makes that worth checking rather than assuming is whether disagreement is
actually a good detector of error. If the two cheap models fail on the SAME
entries -- both misread the same 13px glyph -- they agree and are both wrong,
the escalation never fires, and the cascade buys nothing. This measures that
directly: how many of the real errors land inside the disagreement set.

    python cascade.py
    python cascade.py --primary gemini-2.5-flash-lite_r11 --second gemini-2.5-flash_r33
"""
import argparse
import json
import sys

import pricing
import sheet
from score_sheet import RESULTS, norm_handle, run_files, score_run

DEFAULT_PRIMARY = "gemini-2.5-flash-lite_r33"
DEFAULT_SECOND = "gemini-2.5-flash_r33"
DEFAULT_ARBITER = "gemini-3.6-flash_r33"


def load(stem, roster):
    """Find the run file whose name contains `stem`, scored."""
    for f in run_files():
        if stem in f.name:
            run = json.loads(f.read_text(encoding="utf-8"))
            s = score_run(run, roster)
            s["_pred"] = {e["n"]: e for e in run["entries"]
                          if isinstance(e.get("n"), int)}
            s["_stem"] = f.name
            return s
    raise SystemExit(f"no run file matching {stem!r}")


def per_entry_usd(s):
    usd = s.get("usd")
    return (usd / sheet.N_ENTRIES) if usd else 0.0


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--primary", default=DEFAULT_PRIMARY)
    ap.add_argument("--second", default=DEFAULT_SECOND)
    ap.add_argument("--arbiter", default=DEFAULT_ARBITER)
    a = ap.parse_args(argv)

    roster = sheet.roster()
    truth = {r["n"]: norm_handle(r["handle"]) for r in roster}
    p, q, arb = (load(a.primary, roster), load(a.second, roster),
                 load(a.arbiter, roster))

    def h(s, n):
        return norm_handle(s["_pred"].get(n, {}).get("handle"))

    agree, disagree = [], []
    for n in truth:
        (agree if h(p, n) == h(q, n) else disagree).append(n)

    # How good a detector is disagreement?
    wrong = {n for n in truth if h(p, n) != truth[n]}
    caught = wrong & set(disagree)
    silent = wrong & set(agree)

    final = {}
    for n in truth:
        final[n] = h(arb, n) if n in disagree else h(p, n)
    correct = sum(1 for n in truth if final[n] == truth[n])

    cost_all_cheap = (per_entry_usd(p) + per_entry_usd(q)) * sheet.N_ENTRIES
    # The arbiter is billed for a whole sheet even to settle a few entries --
    # it is one call over the same image, not a per-entry charge. Charging it
    # pro-rata would understate the cascade.
    cost_arb = arb.get("usd") or 0.0
    total = cost_all_cheap + (cost_arb if disagree else 0.0)

    print(f"primary  {p['model']:<26} {p['handle_exact']}/99  "
          f"${per_entry_usd(p) * 1000:.3f}/1k")
    print(f"second   {q['model']:<26} {q['handle_exact']}/99  "
          f"${per_entry_usd(q) * 1000:.3f}/1k")
    print(f"arbiter  {arb['model']:<26} {arb['handle_exact']}/99  "
          f"${per_entry_usd(arb) * 1000:.3f}/1k")

    print(f"\nthe two cheap models disagree on {len(disagree)}/99 entries: "
          f"{sorted(disagree)}")
    print(f"primary was wrong on {len(wrong)}: {sorted(wrong)}")
    print(f"  caught by disagreement : {len(caught)}  {sorted(caught)}")
    print(f"  missed (both agreed and both wrong): {len(silent)}  {sorted(silent)}")

    print(f"\ncascade result: {correct}/99 handles exact")
    print(f"cascade cost  : ${total / sheet.N_ENTRIES * 1000:.3f} per 1000 profiles")
    print(f"arbiter alone : {arb['handle_exact']}/99 at "
          f"${per_entry_usd(arb) * 1000:.3f} per 1000 profiles")

    if len(silent):
        print("\nDisagreement does not catch every error -- the two cheap models "
              "share failure modes, so a cascade cannot be assumed to reach the "
              "arbiter's accuracy.")
    for n in sorted(wrong):
        print(f"  {n:>3} key {truth[n]:<20} primary {h(p, n):<20} "
              f"second {h(q, n):<20} arbiter {h(arb, n)}")


if __name__ == "__main__":
    main(sys.argv[1:])
