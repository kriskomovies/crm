"""Print what one run actually returned, entry by entry, marked against the key.

The score tables say 97/99; this shows the 99. A mark in the left column means
that field differs from ground_truth.json, so a run can be read as output and as
an error report at the same time.

    python show_run.py sheet_gemini-2.5-flash-lite_r33.json
    python show_run.py sheet_gemini-2.5-flash-lite_r33.json --raw    # the reply
"""
import json
import sys
from pathlib import Path

import sheet
from score_sheet import RESULTS, emoji_key, norm_handle
from score import norm_text, strip_emoji


def main(argv):
    show_raw = "--raw" in argv
    argv = [a for a in argv if not a.startswith("--")]
    name = argv[0] if argv else "sheet_gemini-2.5-flash-lite_r33.json"
    path = Path(name) if Path(name).exists() else RESULTS / name
    run = json.loads(path.read_text(encoding="utf-8"))

    if show_raw:
        for c in run["calls"]:
            print(f"--- entries {c.get('entries')}  {c.get('seconds')}s ---")
            print(c.get("raw", c.get("error", "")))
        return

    roster = {r["n"]: r for r in sheet.roster()}
    pred = {e["n"]: e for e in run["entries"] if isinstance(e.get("n"), int)}
    secs = run.get("total_seconds")
    print(f"{run['model']}   {len(run['calls'])} call(s)   {secs}s   "
          f"{run.get('prompt_tokens')} in / {run.get('completion_tokens')} out\n")
    print(f"{'':2}{'#':>3}  {'display name':<26}{'handle':<20}"
          f"{'nationality':<14}{'conf':<7}")
    print("-" * 78)
    bad_h = bad_n = bad_e = 0
    for n in sorted(roster):
        e = pred.get(n, {})
        want = roster[n]
        h_ok = norm_handle(e.get("handle")) == norm_handle(want["handle"])
        n_ok = (norm_text(strip_emoji(e.get("display_name")))
                == norm_text(strip_emoji(want["display_name"])))
        # Emoji are tracked separately because a run can be perfect on every
        # letter and still differ here, and then a table with no marks in it
        # looks unverifiable rather than correct.
        e_ok = emoji_key(e.get("display_name")) == emoji_key(want["display_name"])
        bad_h += not h_ok
        bad_n += not n_ok
        bad_e += not e_ok
        mark = ("!!" if not h_ok else "~" if not n_ok else "e" if not e_ok else "")
        print(f"{mark:<2}{n:>3}  {str(e.get('display_name', ''))[:24]:<26}"
              f"{str(e.get('handle', ''))[:18]:<20}"
              f"{str(e.get('nationality', ''))[:12]:<14}"
              f"{str(e.get('nationality_confidence', ''))[:6]:<7}")
        if not h_ok:
            print(f"      key: {want['display_name']!r} / {want['handle']}")
        elif not n_ok or not e_ok:
            print(f"      key: {want['display_name']!r}")
    print(f"\n{99 - bad_h}/99 handles, {99 - bad_n}/99 names "
          f"(emoji-stripped), {99 - bad_e}/99 exact emoji")
    print("!! = handle wrong   ~ = name text differs   e = emoji differ, text right")


if __name__ == "__main__":
    main(sys.argv[1:])
