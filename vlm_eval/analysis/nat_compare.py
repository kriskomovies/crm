"""Which models produce the same origin calls as the reference, and how do they differ?

There is no key for this field, so "matching gemini-3.6-flash" means agreeing
with it, not being right. It is still the useful comparison, because that model
is the one making the most calls with none of the panel-confident origins
flattened -- but nothing here establishes that its answers are correct, and a
model that disagrees may simply be more careful.

Disagreement is split into two kinds, because they are not the same failure:

  flattened   the reference names an origin, the challenger says American or
              unknown. This is the model declining to infer, and it is what
              makes a cheap model's nationality column useless while its
              transcription stays excellent.
  different   both name an origin and they disagree, e.g. italian vs romanian
              for `Gabriel Luca`. Genuine ambiguity, not laziness.

    python nat_compare.py
    python nat_compare.py --ref sheet_gemini-3-pro-preview_r33.json
"""
import argparse
import json
import sys
from pathlib import Path

import sheet
from score_sheet import best_per_model, run_files, score_run

REF_MODEL = "gemini-3.6-flash"
VAGUE = {"", "american", "unknown", "n/a", "none"}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default=REF_MODEL,
                    help="reference model id (not a filename)")
    ap.add_argument("--min-handles", type=int, default=90,
                    help="ignore runs that could not read the sheet")
    a = ap.parse_args(argv)

    roster = sheet.roster()
    scored = []
    for f in run_files():
        run = json.loads(f.read_text(encoding="utf-8"))
        s = score_run(run, roster)
        scored.append(s)

    best = best_per_model([s for s in scored if s["handle_exact"] >= a.min_handles])
    ref = next((s for s in best if s["model"] == a.ref), None)
    if ref is None:
        raise SystemExit(f"no run for {a.ref!r} above {a.min_handles} handles")

    ref_nat = ref["nationality"]
    ref_calls = {n for n, v in ref_nat.items() if v not in VAGUE}
    print(f"reference: {ref['model']}  ({ref['handle_exact']}/99 handles, "
          f"{len(ref_calls)} origin calls)\n")

    rows = []
    for s in best:
        if s["model"] == a.ref:
            continue
        same = flat = diff = extra = 0
        flat_ex, diff_ex = [], []
        for n in range(1, sheet.N_ENTRIES + 1):
            r, c = ref_nat.get(n, ""), s["nationality"].get(n, "")
            if r == c:
                same += 1
            elif r not in VAGUE and c in VAGUE:
                flat += 1
                flat_ex.append((n, r))
            elif r in VAGUE and c not in VAGUE:
                extra += 1
            else:
                diff += 1
                diff_ex.append((n, r, c))
        rows.append((s, same, flat, diff, extra, flat_ex, diff_ex))

    rows.sort(key=lambda r: -r[1])
    print(f"{'model':<28}{'handles':>8}{'$/1k':>8}{'agree':>7}{'flattened':>11}"
          f"{'differ':>8}{'extra':>7}")
    print("-" * 77)
    for s, same, flat, diff, extra, _, _ in rows:
        usd = f"{s['usd_per_1k']:.3f}" if s["usd_per_1k"] is not None else "n/a"
        print(f"{s['model']:<28}{s['handle_exact']:>5}/99{usd:>8}"
              f"{same:>5}/99{flat:>11}{diff:>8}{extra:>7}")

    print("\nagree     = identical answer on that entry")
    print("flattened = reference named an origin, this model said American/unknown")
    print("differ    = both named an origin, and they disagree")
    print("extra     = this model named an origin where the reference did not")

    top = rows[0]
    print(f"\nclosest match: {top[0]['model']} ({top[1]}/99)")
    if top[6]:
        print("  where they genuinely disagree:")
        by_n = {r["n"]: r for r in roster}
        for n, r, c in top[6][:10]:
            print(f"    {n:>3} {by_n[n]['display_name'][:22]:<24}"
                  f"ref {r:<14} vs {c}")


if __name__ == "__main__":
    main(sys.argv[1:])
