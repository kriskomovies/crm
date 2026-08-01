"""Print every entry a run got wrong, key beside prediction.

The aggregate table says a model scored 98/99; this says which one and whether
it was the model's fault. Some misses are a model reading a genuinely ambiguous
glyph -- a 1 against an l, a replacement box for a font the capture could not
render -- and those are a ceiling on the task, not a difference between models.

    python mistakes.py sheet_claude-sonnet-4-6_r33.json
    python mistakes.py --all          # entries that ANY run got wrong, ranked
"""
import json
import sys
from collections import Counter
from pathlib import Path

import sheet
from score_sheet import RESULTS, run_files, score_run


def show(path, roster):
    run = json.loads(Path(path).read_text(encoding="utf-8"))
    s = score_run(run, roster)
    print(f"\n{s['model']}  handle {s['handle_exact']}/99  name {s['name_exact']}/99")
    print("-" * 96)
    for n, tn, th, gn, gh in s["mistakes"]:
        print(f"  {n:>3}  key  {tn!r:<34} {th}")
        print(f"       got  {gn!r:<34} {gh}")
    return s


def main(argv):
    roster = sheet.roster()
    if argv and argv[0] == "--all":
        files = run_files()
        tally, detail = Counter(), {}
        for f in files:
            run = json.loads(f.read_text(encoding="utf-8"))
            s = score_run(run, roster)
            if s["handle_exact"] < 60:      # a broken run would swamp the count
                continue
            for n, tn, th, gn, gh in s["mistakes"]:
                tally[n] += 1
                detail.setdefault(n, (tn, th, []))[2].append(
                    (s["model"], gn, gh))
        print(f"entries missed, across {len(files)} runs (broken runs excluded)\n")
        for n, c in tally.most_common():
            tn, th, got = detail[n]
            print(f"  {n:>3}  x{c:<3} key {tn!r} / {th}")
            for model, gn, gh in got[:4]:
                print(f"          {model:<28} {gn!r} / {gh}")
        return
    for a in (argv or ["sheet_claude-sonnet-4-6_r33.json"]):
        show(RESULTS / a if not Path(a).exists() else a, roster)


if __name__ == "__main__":
    main(sys.argv[1:])
