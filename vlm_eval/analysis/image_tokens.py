"""What does splitting the sheet into more calls actually cost?

The intuition is that a third of the sheet should cost a third of the image
tokens, so three calls would be a wash. It is not, and the reason decides the
whole cost model: vision models resize an image into a fixed tile budget before
tokenising it, so a small crop and a large one can cost nearly the SAME number
of input tokens. Split into N calls and the input bill multiplies by roughly N,
while the output -- the 99 JSON objects, which is the thing you actually wanted
-- stays flat.

This prints image tokens per call against the pixels in that call, so the
relationship is visible instead of assumed.

    python image_tokens.py
    python image_tokens.py gemini-2.5-flash-lite
"""
import json
import sys
from collections import defaultdict

from score_sheet import RESULTS, run_files


def main(argv):
    want = argv[0] if argv else None
    rows = defaultdict(list)
    for f in list(run_files()) + sorted(RESULTS.glob("pages_*.json")):
        if f.name in ("sheet_scores.json", "pages_scores.json"):
            continue
        r = json.loads(f.read_text(encoding="utf-8"))
        if want and want != r["model"]:
            continue
        if "_rep" in f.name or "_solo" in f.name:
            continue
        calls = [c for c in r["calls"] if not c.get("error")]
        if not calls:
            continue
        mode = r.get("mode") or f.name.split("_")[-1].replace(".json", "")
        px = calls[0].get("px", "?")
        w, _, h = px.partition("x")
        try:
            area = int(w) * int(h)
        except ValueError:
            area = 0
        img_tok = [c.get("image_tokens") for c in calls if c.get("image_tokens")]
        rows[r["model"]].append({
            "mode": mode, "calls": len(calls), "px": px, "area": area,
            "in_total": r.get("prompt_tokens") or 0,
            "in_per_call": (r.get("prompt_tokens") or 0) / len(calls),
            "img_per_call": (sum(img_tok) / len(img_tok)) if img_tok else None,
            "out_total": r.get("completion_tokens") or 0,
        })

    for model in sorted(rows):
        rs = sorted(rows[model], key=lambda r: r["calls"])
        print(f"\n{model}")
        print(f"  {'mode':<12}{'calls':>6}{'image px':>13}{'Mpx/call':>10}"
              f"{'in/call':>9}{'img tok':>9}{'in total':>10}{'out total':>10}")
        base = rs[0]["in_total"] if rs else 1
        for r in rs:
            mpx = r["area"] / 1e6
            img = f"{r['img_per_call']:.0f}" if r["img_per_call"] else "-"
            print(f"  {r['mode']:<12}{r['calls']:>6}{r['px']:>13}{mpx:>10.2f}"
                  f"{r['in_per_call']:>9.0f}{img:>9}{r['in_total']:>10}"
                  f"{r['out_total']:>10}"
                  + (f"   {r['in_total'] / base:.1f}x input" if base else ""))

    print("\nRead the 'Mpx/call' and 'in/call' columns together: if input tokens")
    print("per call barely fall when the image gets much smaller, the model is")
    print("padding every image to a fixed tile budget, and N calls costs N times")
    print("the input no matter how finely you slice it.")


if __name__ == "__main__":
    main(sys.argv[1:])
