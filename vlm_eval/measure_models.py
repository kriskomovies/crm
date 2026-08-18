"""Run models over the sheet ONE AT A TIME, with a billing diff around each.

Why this exists: /api/pricing 404s as of 2026-08, so no per-token price is
published to a key holder any more (see pricing.table). The gateway's lifetime
spend counter at /v1/dashboard/billing/usage is the only cost surface left, and
it is a single number with no per-model breakdown -- so the only way to attribute
a cost to a model is to make it the only thing in flight and diff either side.

That is why this is serial and run_sheet.py is concurrent. Concurrency is right
for collecting accuracy and fatal for measuring cost.

    python measure_models.py gemini-3.6-flash gemini-3.5-flash-lite

Writes results/measured_costs.json and prints a table. Accuracy is NOT scored
here -- the run files land in results/ exactly as run_sheet.py writes them, so
score_sheet.py sees them and nothing is measured twice.
"""
import json
import sys
import time
from pathlib import Path

import apimart
import pricing
import run_sheet
import sheet

OUT = Path(__file__).resolve().parent / "results" / "measured_costs.json"

# One sheet is 99 profiles, and every published figure in APIMART.md is per
# 1000, so the run cost is scaled by this to stay comparable.
PER_1000 = 1000 / 99


def measure(model_id, img, key):
    before = pricing.balance_units()
    t0 = time.time()
    run = run_sheet.run_model(model_id, img, 33, 1, False, key, 0.0, label="cost")
    wall = time.time() - t0
    # The counter is not always instantaneous; give it a beat before reading.
    time.sleep(4)
    after = pricing.balance_units()

    usd = (after - before) / pricing.UNITS_PER_USD
    # run_model already sums these and has already saved the run file.
    tok_in = run.get("prompt_tokens") or 0
    tok_out = run.get("completion_tokens") or 0
    errors = [c["error"] for c in run["calls"] if c.get("error")]

    return {
        "model": model_id,
        "seconds": round(wall, 1),
        "in_tokens": tok_in,
        "out_tokens": tok_out,
        "entries_parsed": len(run["entries"]),
        "usd_per_run": round(usd, 6),
        "usd_per_1000": round(usd * PER_1000, 4),
        # Output dominates a reasoning model's bill, so this is the number to
        # sanity-check a published price against.
        "solved_out_per_m": round(usd / tok_out * 1e6, 3) if tok_out else None,
        "errors": errors,
    }


def main(models):
    img = sheet.load_sheet()
    key = apimart.api_key()
    rows = []
    for m in models:
        print(f"measuring {m} ...", flush=True)
        try:
            r = measure(m, img, key)
        except Exception as e:                  # noqa: BLE001 - a dead model is a result
            r = {"model": m, "errors": [f"{type(e).__name__}: {e}"[:200]]}
        rows.append(r)
        print(f"  {json.dumps(r)}", flush=True)

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(rows, indent=1), encoding="utf-8")

    print(f"\n{'model':<32}{'sec':>7}{'in':>8}{'out':>8}{'got':>5}"
          f"{'$/run':>10}{'$/1000':>10}{'$/M out':>10}")
    print("-" * 92)
    for r in rows:
        if r.get("usd_per_run") is None:
            print(f"{r['model']:<32}  {(r.get('errors') or ['?'])[0][:50]}")
            continue
        print(f"{r['model']:<32}{r['seconds']:>7.1f}{r['in_tokens']:>8}"
              f"{r['out_tokens']:>8}{r['entries_parsed']:>5}"
              f"{r['usd_per_run']:>10.5f}{r['usd_per_1000']:>10.4f}"
              f"{(r['solved_out_per_m'] or 0):>10.2f}")
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main(sys.argv[1:] or ["gemini-3.6-flash"])
