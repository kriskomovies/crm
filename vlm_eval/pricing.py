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

# Transcribed by hand from https://apimart.ai/pricing on 2026-08-04, because
# /api/pricing no longer answers (see table()). These are the gateway's "Our
# Price" column -- it lists a 20% discount against the vendor's official rate,
# and the discounted figure is what is actually billed.
#
# A published price is weaker evidence than a measured one: the page is a
# marketing surface, the discount could lapse, and nothing here has been checked
# against a billing delta. measure_models.py exists to do exactly that check, and
# MEASURED wins wherever the two disagree.
PUBLISHED = {
    "qwen3.6-flash": {"in_per_m": 0.13712, "out_per_m": 0.82272},
    "qwen3.6-plus":  {"in_per_m": 0.22864, "out_per_m": 1.37184},
    "qwen3.7-plus":  {"in_per_m": 0.22864, "out_per_m": 0.91456},
    "qwen-turbo":    {"in_per_m": 0.24,    "out_per_m": 2.4},
    "qwen3.7-max":   {"in_per_m": 1.37136, "out_per_m": 4.11408},

    # The gemini shelf. Note what these say about where the money goes: the
    # -nothinking variants are priced identically to their thinking twins, so
    # the saving is not in the RATE, it is in how many output tokens the model
    # emits. gemini-3.6-flash spent 15,560 output tokens on one sheet and ~98%
    # of its bill; a variant that does not think should produce a fraction of
    # that for the same 99 objects. That is the hypothesis worth testing.
    "gemini-3.6-flash":                  {"in_per_m": 1.2,  "out_per_m": 6.0},
    "gemini-3.5-flash":                  {"in_per_m": 1.2,  "out_per_m": 7.2},
    "gemini-3.5-flash-lite":             {"in_per_m": 0.24, "out_per_m": 1.9992},
    "gemini-3.1-pro-preview":            {"in_per_m": 1.6,  "out_per_m": 9.6},
    "gemini-3-flash-preview":            {"in_per_m": 0.4,  "out_per_m": 2.4},
    "gemini-3-flash-preview-nothinking": {"in_per_m": 0.4,  "out_per_m": 2.4},
    "gemini-3-pro-preview":              {"in_per_m": 1.6,  "out_per_m": 9.6},
    "gemini-3-pro-preview-thinking":     {"in_per_m": 1.6,  "out_per_m": 9.6},
    "gemini-2.5-pro-thinking":           {"in_per_m": 1.0,  "out_per_m": 8.0},
    "gemini-2.5-pro-nothinking":         {"in_per_m": 1.0,  "out_per_m": 8.0},
    "gemini-2.5-flash-thinking":         {"in_per_m": 0.24, "out_per_m": 1.99992},
    "gemini-2.5-flash-nothinking":       {"in_per_m": 0.24, "out_per_m": 1.99992},
}

_CACHE = None
_WARNED = False


def balance_units():
    """The gateway's own lifetime spend counter, in its private unit.

    /v1/dashboard/billing/usage is the one cost surface that still answers, and
    diffing it around an isolated run is now the ONLY way to price a model here
    -- see the note on table(). One number, no per-model breakdown, so a run
    being measured has to be the only thing in flight.
    """
    req = urllib.request.Request(
        "https://api.apimart.ai/v1/dashboard/billing/usage",
        headers={"Authorization": f"Bearer {apimart.api_key()}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return float(json.loads(r.read().decode())["total_usage"])


def balance_usd():
    return balance_units() / UNITS_PER_USD


def table():
    """Published prices, or what is left of them.

    /api/pricing 404s as of 2026-08 -- the gateway dropped it, and there is no
    replacement: /api/models/price and /api/user/pricing both 401 with a working
    key, so they are console-session routes rather than API ones. Nothing on the
    gateway publishes per-token prices to a key holder any more.

    So this degrades to MEASURED rather than raising. That matters because
    score_sheet.py calls cost() for every run: a dead endpoint used to take the
    whole scoring pass down with it, losing accuracy numbers that need no prices
    at all. An unpriced model now reports its tokens and a blank cost, which is
    the honest answer, and cost() already returns None for anything unknown.

    To price a model now, measure it: balance_units() either side of an isolated
    run, divided by the tokens that run reported. Output is ~95-98% of the bill
    on a reasoning model, so solving on output alone lands within ~3%.
    """
    global _CACHE, _WARNED
    if _CACHE is None:
        try:
            req = urllib.request.Request(
                "https://api.apimart.ai/api/pricing",
                headers={"Authorization": f"Bearer {apimart.api_key()}"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode())["data"]
        except Exception as e:                  # noqa: BLE001 - any failure degrades
            if not _WARNED:
                print(f"pricing: /api/pricing unavailable ({type(e).__name__}); "
                      f"falling back to measured prices only. Costs for other "
                      f"models will read as blank, not as zero.", file=sys.stderr)
                _WARNED = True
            # MEASURED first, PUBLISHED over the top: a solved price exists only
            # because the vendor published nothing, so the moment a real figure
            # appears it wins. gemini-3.6-flash is the case in point -- solved at
            # $1.02/$6.13 when it was unlisted, published at $1.2/$6.0, which is
            # within 4% on the output rate that carries ~98% of the bill.
            _CACHE = {k: dict(v) for k, v in MEASURED.items()}
            _CACHE.update({k: {"per_call": 0, "vision": True, **v}
                           for k, v in PUBLISHED.items()})
            return _CACHE
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
    if argv and argv[0] == "--balance":
        print(f"{balance_units():.4f} units = ${balance_usd():.4f}")
        return
    t = table()
    ids = [i for i in t if not argv or any(a.lower() in i.lower() for a in argv)]
    ids.sort(key=lambda i: t[i]["in_per_m"])
    print(f"{'model':<38}{'$/M in':>10}{'$/M out':>10}{'per call':>10}")
    print("-" * 68)
    for i in ids:
        p = t[i]
        print(f"{i:<38}{p['in_per_m']:>10.3f}{p['out_per_m']:>10.3f}"
              f"{p['per_call'] or '':>10}")
    if len(t) <= len(MEASURED):
        print("\nOnly measured prices are available; see table().", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
