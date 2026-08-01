"""Solve a model's real token price from one observed bill, then quote $/1000 profiles.

Needed for models the gateway does not price (`model_ratio: 0`). The dashboard
gives a total for a model over some number of calls; this sums the tokens those
calls actually used, from results/, and divides.

Dividing the bill by the CALL COUNT would be wrong and badly so: the 13 calls
behind gemini-3.6-flash's $0.66 were four different experiments with output sizes
from 1.4k to 12k tokens, so a per-call average describes none of them. Cost here
is ~98% output tokens, so tokens are the only sane denominator.

The input/output split is not separately observable from one total, so it is
pinned to the 1:6 ratio the rest of that vendor's line publishes. Output
dominates so heavily that the assumption barely moves the answer -- the script
prints the output-only bound too, and they agree to about 1%.

    python solve_price.py gemini-3.6-flash 0.66 13
"""
import json
import sys
from pathlib import Path

import sheet
from score_sheet import RESULTS

IN_OUT_RATIO = 6.0     # output $/M is this many times input $/M, per vendor list


def calls_for(model, exclude=()):
    """Every recorded call for a model, newest files last."""
    out = []
    for f in sorted(RESULTS.glob("*.json")):
        if f.name in ("sheet_scores.json", "pages_scores.json",
                      "nationality_consensus.json", "apimart_probe.json"):
            continue
        if any(x in f.name for x in exclude):
            continue
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not isinstance(r, dict) or r.get("model") != model:
            continue
        for c in r.get("calls", []):
            if c.get("error"):
                continue
            out.append({"file": f.name,
                        "in": c.get("prompt_tokens") or 0,
                        "out": c.get("completion_tokens") or 0})
    probe = RESULTS / "apimart_probe.json"
    if probe.exists() and "probe" not in exclude:
        for row in json.loads(probe.read_text(encoding="utf-8"))["rows"]:
            if row.get("model") == model and not row.get("error"):
                out.append({"file": "probe", "in": row.get("prompt_tokens") or 0,
                            "out": row.get("completion_tokens") or 0})
    return out


def main(argv):
    model = argv[0]
    billed = float(argv[1])
    n_calls = int(argv[2]) if len(argv) > 2 else None
    # measure_cost.py calls are billed but not written to results/, so their
    # tokens have to be supplied or the solved rate comes out inflated -- the
    # bill would be divided by less usage than actually produced it.
    extra = None
    rest = []
    for a in argv[3:]:
        if a.startswith("extra="):     # extra=<calls>:<in>:<out>
            c, i, o = a.split("=", 1)[1].split(":")
            extra = {"calls": int(c), "in": int(i), "out": int(o)}
        else:
            rest.append(a)
    exclude = rest

    calls = calls_for(model, exclude)
    if extra:
        calls.append({"file": f"measure_cost.py x{extra['calls']} (unsaved)",
                      "in": extra["in"], "out": extra["out"]})
        n_recorded = len(calls) - 1 + extra["calls"]
    else:
        n_recorded = len(calls)
    tin = sum(c["in"] for c in calls)
    tout = sum(c["out"] for c in calls)
    print(f"{model}: {n_recorded} accounted calls"
          + (f" (dashboard says {n_calls})" if n_calls else ""))
    for c in calls:
        print(f"  {c['file']:<44} in={c['in']:>6} out={c['out']:>7}")
    print(f"  {'TOTAL':<44} in={tin:>6} out={tout:>7}")
    if n_calls and n_recorded != n_calls:
        print(f"\n  NOTE: {n_calls - n_recorded} call(s) unaccounted for, so the")
        print(f"  derived rate is an UPPER bound -- real usage was higher than")
        print(f"  the tokens recorded here, which makes $/token look larger.")

    out_only = billed / tout * 1e6
    rate_out = billed / (tin / IN_OUT_RATIO + tout) * 1e6
    rate_in = rate_out / IN_OUT_RATIO
    print(f"\nsolved: ${rate_in:.2f}/M input, ${rate_out:.2f}/M output")
    print(f"        (output-only bound ${out_only:.2f}/M -- {abs(out_only / rate_out - 1) * 100:.1f}% apart)")

    print(f"\ncost per 1000 profiles, by mode:")
    print(f"  {'mode':<14}{'calls':>6}{'in':>8}{'out':>8}{'per pass':>11}{'$/1000':>10}")
    for f in sorted(RESULTS.glob("*.json")):
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not isinstance(r, dict) or r.get("model") != model or not r.get("calls"):
            continue
        i, o = r.get("prompt_tokens") or 0, r.get("completion_tokens") or 0
        if not o:
            continue
        usd = (i * rate_in + o * rate_out) / 1e6
        mode = r.get("mode") or f.name.split("_")[-1].replace(".json", "")
        print(f"  {mode:<14}{len(r['calls']):>6}{i:>8}{o:>8}"
              f"{usd:>10.4f}{usd / sheet.N_ENTRIES * 1000:>10.3f}")


if __name__ == "__main__":
    main(sys.argv[1:])
