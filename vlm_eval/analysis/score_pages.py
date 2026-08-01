"""Score results/pages_*.json against the 99-entry roster.

**Why this does not use ground_truth.json's `position` field.** That field counts
rows as the original extraction agents saw them, including a clipped row at the
top of the screen that ../rows.py deliberately crops away -- and whether such a
row existed depends on where each scroll landed. So the offset between a GT
position and a crop row is 0 on page_02 and 1 on page_05, page by page, with
nothing in the data to say which. Scoring positionally against it reported
gemini-3.6-flash at 95/122 when every row it emitted was in fact correct; the
27 "errors" were pages 05 and 08 being off by one. Any metric that can do that
is the wrong metric.

What is used instead needs no alignment at all:

  read        of every row emitted across the 9 pages, how many are a handle
              that really exists in the roster, read exactly right
  unique      how many of the 99 accounts were captured correctly at least once
  invented    handles emitted that match no real account -- the failure that
              matters, since a caller cannot detect it
  order       per page, are the matched accounts in increasing roster order?
              This catches skipping and reordering without needing positions,
              because the roster order IS the scroll order

    python score_pages.py
"""
import json
import sys
from pathlib import Path

import pricing
import sheet
from score import norm_text, strip_emoji
from score_sheet import RESULTS, norm_handle

RESULTS_GLOB = "pages_*.json"
SUMMARY = "pages_scores.json"


def score_run(run, roster):
    by_handle = {norm_handle(r["handle"]): r for r in roster}
    emitted = read_ok = name_ok = invented = 0
    seen_ok = set()
    order_bad = []
    for page in sorted(run.get("pages", {})):
        idxs = []
        for e in run["pages"][page]:
            emitted += 1
            h = norm_handle(e.get("handle"))
            want = by_handle.get(h)
            if want is None:
                invented += 1
                continue
            read_ok += 1
            seen_ok.add(h)
            idxs.append(want["n"])
            if (norm_text(strip_emoji(e.get("display_name")))
                    == norm_text(strip_emoji(want["display_name"]))):
                name_ok += 1
        if idxs != sorted(idxs):
            order_bad.append(page)

    usd = pricing.cost(run["model"], run.get("prompt_tokens"),
                       run.get("completion_tokens"))
    uniq = len(seen_ok)
    return {"model": run["model"], "mode": run.get("mode"),
            "seconds": run.get("total_seconds"),
            "calls": len(run.get("calls", [])),
            "errors": sum(1 for c in run.get("calls", []) if c.get("error")),
            "prompt_tokens": run.get("prompt_tokens"),
            "completion_tokens": run.get("completion_tokens"),
            "emitted": emitted, "read_ok": read_ok, "name_ok": name_ok,
            "invented": invented, "uniq": uniq,
            "order_bad": order_bad,
            "usd": usd,
            "usd_per_1k": round(usd / max(uniq, 1) * 1000, 4) if usd is not None else None}


def main(argv):
    roster = sheet.roster()
    files = ([RESULTS / a for a in argv] if argv
             else sorted(p for p in RESULTS.glob(RESULTS_GLOB)
                         if p.name != SUMMARY))
    if not files:
        raise SystemExit("no results/pages_*.json -- run run_pages.py first")

    scored = [score_run(json.loads(f.read_text(encoding="utf-8")), roster)
              for f in files]
    scored.sort(key=lambda s: (-s["uniq"], s["invented"]))

    print("\npage mode: 14 entries per call, 9 overlapping pages "
          f"covering {len(roster)} accounts\n")
    print(f"{'model':<26}{'sec':>7}{'in tok':>8}{'out tok':>8}{'$/1k':>8}"
          f"{'emitted':>9}{'read ok':>9}{'invented':>10}{'unique':>9}{'order':>7}")
    print("-" * 101)
    for s in scored:
        usd = f"{s['usd_per_1k']:.3f}" if s["usd_per_1k"] is not None else "n/a"
        print(f"{s['model']:<26}{s['seconds'] or 0:>7.1f}"
              f"{s['prompt_tokens'] or 0:>8}{s['completion_tokens'] or 0:>8}{usd:>8}"
              f"{s['emitted']:>9}{s['read_ok']:>9}{s['invented']:>10}"
              f"{s['uniq']:>6}/{len(roster):<2}"
              f"{('ok' if not s['order_bad'] else str(len(s['order_bad'])) + ' bad'):>7}")

    print(f"\nread ok  = rows whose handle exactly matches a real account")
    print(f"invented = handles matching no account (undetectable downstream)")
    print(f"unique   = of {len(roster)} accounts, how many were captured correctly")

    out = RESULTS / SUMMARY
    out.write_text(json.dumps(scored, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n-> {out}")
    return scored


if __name__ == "__main__":
    main(sys.argv[1:])
