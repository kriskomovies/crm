"""Rescore a bakeoff run, separating transcription from numbering.

The first scoring compared handles position by position and gpt-5.4-mini came
out at 42/97. Reading the splits, almost all of them are one rotation: at
positions 47, 48, 49 the same three handles appear shifted by one. That is a
numbering fault, not a reading fault, and the two matter for different reasons:

  a misread handle    is a wrong person, and nothing downstream can detect it.
  a misnumbered row   is the right people in the wrong order, which only
                      matters here because the scorer lines answers up by
                      position -- the agent keys on the handle.

So both are reported. `set` asks whether the model produced the handle at all;
`pos` asks whether it also put it in the right slot; `shift` reports the offset
that would maximise positional agreement, which identifies a rotation for what
it is instead of scoring it as 55 misreads.

    python bakeoff_score.py --tag live
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pricing

RESULTS = Path(__file__).resolve().parent / "results"
HANDLE_RE = re.compile(r"^[a-z][a-z0-9._-]{2,14}$")

# Where the gateway publishes nothing, these are the vendors' own list prices.
# Flagged in the output so a listed price is never mistaken for a measured one.
LIST_PRICES = {
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gpt-5.4-mini": (0.25, 2.00),
}


def norm(h):
    return re.sub(r"[^a-z0-9._-]", "", (h or "").strip().lower().lstrip("@"))


def load(tag):
    runs = []
    for p in sorted(RESULTS.glob(f"bakeoff_*_{tag}.json")):
        if "consensus" in p.name:
            continue
        r = json.loads(p.read_text(encoding="utf-8"))
        if r.get("entries"):
            runs.append(r)
    return runs


def best_shift(entries, ref):
    """The numbering offset that best lines a run up with the reference."""
    best, best_k = -1, 0
    for k in range(-3, 4):
        hit = sum(1 for e in entries
                  if ref.get((e.get("n") or 0) + k) == norm(e.get("handle")))
        if hit > best:
            best, best_k = hit, k
    return best_k, best


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="live")
    ap.add_argument("--entries", type=int, default=97)
    a = ap.parse_args(argv)

    runs = load(a.tag)
    if len(runs) < 2:
        raise SystemExit(f"need >=2 runs for tag {a.tag}, found {len(runs)}")
    print(f"{len(runs)} runs, {a.entries} entries\n")

    # Consensus by position, but built only from models that are not rotated:
    # a rotated model would otherwise drag every position it touches.
    votes = {}
    for r in runs:
        for e in r["entries"]:
            n = e.get("n")
            if isinstance(n, int) and 1 <= n <= a.entries:
                votes.setdefault(n, Counter())[norm(e.get("handle"))] += 1
    ref = {n: c.most_common(1)[0][0] for n, c in votes.items()}

    # The reference SET is order-free and much more robust than the positions.
    refset = set(ref.values())

    print(f"{'model':<24}{'sec':>7}{'set':>7}{'pos':>7}{'shift':>7}"
          f"{'shifted pos':>13}{'solo':>6}{'invalid':>9}{'$/1k':>10}")
    print("-" * 92)
    for r in sorted(runs, key=lambda x: x["model"]):
        hs = [norm(e.get("handle")) for e in r["entries"]]
        inset = sum(1 for h in hs if h in refset)
        pos = sum(1 for e in r["entries"]
                  if ref.get(e.get("n")) == norm(e.get("handle")))
        k, khit = best_shift(r["entries"], ref)
        solo = sum(1 for h in hs
                   if sum(1 for o in runs for oe in o["entries"]
                          if norm(oe.get("handle")) == h) == 1)
        invalid = sum(1 for h in hs if not HANDLE_RE.match(h))

        usd = pricing.cost(r["model"], r["prompt_tokens"], r["completion_tokens"])
        note = ""
        if usd is None and r["model"] in LIST_PRICES:
            pin, pout = LIST_PRICES[r["model"]]
            usd = (r["prompt_tokens"] * pin + r["completion_tokens"] * pout) / 1e6
            note = "*"
        cost = f"${usd / a.entries * 1000:.3f}{note}" if usd else "n/a"

        print(f"{r['model']:<24}{r['seconds']:>7.1f}{inset:>7}{pos:>7}"
              f"{k:>7}{khit:>13}{solo:>6}{invalid:>9}{cost:>10}")

    print("\nset         = handle appears somewhere in the panel reference")
    print("pos         = also at the same entry number")
    print("shift       = numbering offset that best aligns the run")
    print("shifted pos = positional agreement after undoing that offset")
    print("solo        = handle no other model produced (likely invented)")
    print("*           = vendor list price, not measured at the gateway")

    solos = Counter()
    for r in runs:
        for e in r["entries"]:
            h = norm(e.get("handle"))
            if sum(1 for o in runs for oe in o["entries"]
                   if norm(oe.get("handle")) == h) == 1:
                solos[r["model"]] += 1
                print(f"  solo  {r['model']:<24} n={e.get('n'):<4} {h}")
    if not solos:
        print("\nno model produced a handle that no other model saw.")


if __name__ == "__main__":
    main(sys.argv[1:])
