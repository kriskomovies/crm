"""Check the computed prices against what the account was actually charged.

The gateway dashboard reports **total spend per model**, which is price times
however many times that model happened to be called. That makes it very easy to
misread: the model this benchmark called 13 times looks expensive and the one it
called 5 times looks cheap, regardless of what a single pass over the 99 entries
costs. This script removes the call count from the comparison.

It sums the tokens actually recorded in results/ per model, prices them with
pricing.py, and puts that beside the dashboard figure. Agreement validates the
ratio arithmetic; disagreement means the published ratio is wrong for that model
and the dashboard wins.

Dashboard figures are entered by hand from the gateway UI, since there is no API
for the per-model breakdown. Update OBSERVED when re-running.

    python reconcile.py
"""
import json
from collections import defaultdict

import pricing
from score_sheet import RESULTS, run_files

# (credits, approx USD, calls) read off the gateway's POPULAR MODELS panel.
# Credits are the gateway's own unit; ~$0.10 each by its own conversion.
OBSERVED = {
    "gemini-3-pro-preview":      (6.93, 0.69, 9),
    "gemini-3.6-flash":          (6.57, 0.66, 13),
    "gemini-2.5-flash":          (2.06, 0.21, 14),
    "gemini-3.1-pro-preview":    (1.69, 0.17, None),
    "gpt-5.2":                   (1.14, 0.11, None),
    "gemini-3.5-flash":          (0.99, 0.10, None),
    "claude-sonnet-4-6":         (0.62, 0.06, None),
    "gpt-5.1":                   (0.59, 0.06, 6),
    "gpt-4.1":                   (0.39, 0.04, 5),
    "gpt-4.1-mini":              (0.31, 0.03, 9),
    "gemini-2.5-flash-lite":     (None, None, 10),
    "gpt-5.4-mini":              (None, None, 6),
    "gpt-5-mini":                (None, None, 4),
}


def main():
    tok = defaultdict(lambda: {"in": 0, "out": 0, "calls": 0})
    for f in run_files():
        r = json.loads(f.read_text(encoding="utf-8"))
        t = tok[r["model"]]
        for c in r["calls"]:
            if c.get("error"):
                continue
            t["in"] += c.get("prompt_tokens") or 0
            t["out"] += c.get("completion_tokens") or 0
            t["calls"] += 1

    # The triage probe hit ~29 models once each; small, but it is real spend and
    # leaving it out would make every predicted total look low.
    probe = RESULTS / "apimart_probe.json"
    if probe.exists():
        for row in json.loads(probe.read_text(encoding="utf-8"))["rows"]:
            if row.get("error"):
                continue
            t = tok[row["model"]]
            t["in"] += row.get("prompt_tokens") or 0
            t["out"] += row.get("completion_tokens") or 0
            t["calls"] += 1

    print(f"{'model':<26}{'calls':>6}{'obs':>6}{'in tok':>8}{'out tok':>9}"
          f"{'predicted':>11}{'charged':>9}{'ratio':>7}")
    print("-" * 82)
    rows = []
    for m, t in tok.items():
        obs = OBSERVED.get(m)
        pred = pricing.cost(m, t["in"], t["out"])
        rows.append((m, t, obs, pred))
    rows.sort(key=lambda r: -(r[3] or 0))
    for m, t, obs, pred in rows:
        charged = obs[1] if obs and obs[1] is not None else None
        obs_calls = obs[2] if obs else None
        ratio = (pred / charged) if (pred and charged) else None
        print(f"{m:<26}{t['calls']:>6}"
              f"{(obs_calls if obs_calls is not None else '-'):>6}"
              f"{t['in']:>8}{t['out']:>9}"
              f"{('$%.3f' % pred) if pred is not None else 'n/a':>11}"
              f"{('$%.2f' % charged) if charged is not None else '-':>9}"
              f"{('%.2fx' % ratio) if ratio else '-':>7}")

    print("\nratio ~1.0 means pricing.py agrees with the bill for that model.")
    print("Per-pass cost, which is the number that actually decides anything, is")
    print("in `python score_sheet.py` -- not in a dashboard total.")


if __name__ == "__main__":
    main()
