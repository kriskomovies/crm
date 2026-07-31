"""Measure what a model really costs, by watching the account balance move.

Needed because the gateway publishes no price for some models -- gemini-3.6-flash
comes back model_ratio 0 -- and "free" and "unlisted" look identical in the
catalogue. Running one model alone and diffing /dashboard/billing/usage settles
it, and running a model whose price IS published in the same way validates the
ratio arithmetic in pricing.py against ground truth.

    python measure_cost.py gemini-3.6-flash 4
    python measure_cost.py gemini-2.5-flash-lite 4    # calibration
"""
import json
import sys
import urllib.request

import apimart
import pricing
import sheet
import sheet_task


def usage():
    req = urllib.request.Request(
        "https://api.apimart.ai/v1/dashboard/billing/usage",
        headers={"Authorization": f"Bearer {apimart.api_key()}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())["total_usage"]


def main(argv):
    model_id = argv[0]
    reps = int(argv[1]) if len(argv) > 1 else 3
    img = sheet.load_sheet()
    uri = apimart.png_data_uri(img)
    prompt = sheet_task.prompt(sheet.N_ENTRIES, 1, sheet.N_ENTRIES)
    m = apimart.Model(model_id)

    before = usage()
    tin = tout = 0
    for i in range(reps):
        _, meta = m.ask(prompt, [uri])
        tin += meta.get("prompt_tokens") or 0
        tout += meta.get("completion_tokens") or 0
        print(f"  run {i + 1}: {meta['seconds']:5.1f}s  "
              f"in={meta.get('prompt_tokens')} out={meta.get('completion_tokens')}")
    after = usage()

    delta = after - before
    predicted = pricing.cost(model_id, tin, tout)
    print(f"\n{model_id}: {reps} runs, {tin} in / {tout} out tokens")
    print(f"  billing units consumed : {delta:.4f}")
    print(f"  predicted from ratios  : "
          + (f"${predicted:.4f}" if predicted else "n/a (no published price)"))
    if predicted:
        print(f"  units per predicted $  : {delta / predicted:.2f}"
              if predicted else "")
    # Quote the unit-agnostic thing the caller actually wants.
    print(f"  billing units per 1000 profiles: "
          f"{delta / (reps * sheet.N_ENTRIES) * 1000:.4f}")


if __name__ == "__main__":
    main(sys.argv[1:])
