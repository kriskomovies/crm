"""Token prices for the gateway's models, from its own /api/pricing.

The gateway is one-api-shaped: it publishes ratios, not dollars. The unit is
$0.002 per 1K tokens, i.e. $2 per million, so

    input  $/M = model_ratio * 2
    output $/M = model_ratio * completion_ratio * 2

which is checkable against a model whose real price is known -- claude-sonnet
comes back model_ratio 1.5, completion_ratio 5, giving $3/M in and $15/M out,
which is Anthropic's list price. `model_price > 0` means a flat per-call charge
instead, and those models are priced that way rather than per token.

    python pricing.py                 # everything, cheapest first
    python pricing.py gemini gpt-5    # only ids containing these
"""
import json
import sys
import urllib.request

import apimart

UNIT_PER_M = 2.0        # $ per million tokens at ratio 1

# /v1/dashboard/billing/usage counts in a unit of its own. Calibrated by running
# gemini-2.5-flash -- whose price IS published -- four times and diffing the
# balance: 8.4480 units against a predicted $0.1056, i.e. 80.01 units per dollar.
UNITS_PER_USD = 80.01

# Some models publish model_ratio 0, which means "unlisted", not "free".
#
# gemini-3.6-flash was first estimated at $1.43/M in, $8.58/M out by diffing the
# balance endpoint around four isolated runs. That was ~35% too high, and the
# reason is worth keeping: the balance endpoint's unit had to be calibrated
# against a second model, so its error compounded with the reading error.
#
# The figure below is solved directly from the gateway's own per-model spend
# panel instead -- one number, no intermediate calibration:
#
#   $0.66 billed over 13 calls, of which 12 are accounted for at
#   18,423 input and 104,522 output tokens (see solve_price.py)
#   -> $1.02/M in, $6.13/M out, pinning in:out to the 1:6 that vendor lists.
#
# Output is 98% of the bill, so the split assumption barely matters: solving on
# output alone gives $6.31/M, 2.9% away. The one unaccounted call makes this a
# slight UPPER bound.
#
#   python solve_price.py gemini-3.6-flash 0.66 13 pages_ extra=4:6168:41308
MEASURED = {
    "gemini-3.6-flash": {"in_per_m": 1.02, "out_per_m": 6.13,
                         "per_call": 0, "vision": True, "measured": True},
}

_CACHE = None


def table():
    global _CACHE
    if _CACHE is None:
        req = urllib.request.Request(
            "https://api.apimart.ai/api/pricing",
            headers={"Authorization": f"Bearer {apimart.api_key()}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode())["data"]
        _CACHE = {}
        for m in data:
            ratio = m.get("model_ratio") or 0
            comp = m.get("completion_ratio") or 1
            disc = m.get("discount_rate")
            disc = 1.0 if disc in (None, 0) else disc
            _CACHE[m["model_name"]] = {
                "in_per_m": round(ratio * UNIT_PER_M * disc, 4),
                "out_per_m": round(ratio * comp * UNIT_PER_M * disc, 4),
                "per_call": m.get("model_price") or 0,
                "vision": "image" in str(m.get("description", "")).lower(),
            }
        # A measured price beats an unlisted one; it never overrides a published
        # one, so a vendor publishing a price later just takes effect.
        for mid, p in MEASURED.items():
            if _CACHE.get(mid, {}).get("in_per_m", 0) == 0:
                _CACHE[mid] = dict(p)
    return _CACHE


def cost(model_id, prompt_tokens, completion_tokens):
    """USD for one run. None when the model is priced per call, not per token."""
    p = table().get(model_id)
    if not p:
        return None
    if p["per_call"]:
        return None
    return ((prompt_tokens or 0) * p["in_per_m"]
            + (completion_tokens or 0) * p["out_per_m"]) / 1e6


def main(argv):
    t = table()
    ids = [i for i in t if not argv or any(a.lower() in i.lower() for a in argv)]
    ids.sort(key=lambda i: t[i]["in_per_m"])
    print(f"{'model':<38}{'$/M in':>10}{'$/M out':>10}{'per call':>10}")
    print("-" * 68)
    for i in ids:
        p = t[i]
        print(f"{i:<38}{p['in_per_m']:>10.3f}{p['out_per_m']:>10.3f}"
              f"{p['per_call'] or '':>10}")


if __name__ == "__main__":
    main(sys.argv[1:])
