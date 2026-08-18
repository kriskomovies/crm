"""Run several models over an arbitrary contact sheet and score them by consensus.

run_sheet.py is bolted to ../test/main/all99_3col.png, the one roster with a
hand-checked key. This runs the same prompt over a sheet built fresh by the
agent, where no key exists and none can be made cheaply.

Without a key, "accuracy" has to be earned differently. The reference here is
agreement: a handle several independent models read the same way off the same
pixels is almost certainly what is there, and one only a single model produces
is almost certainly invented. That is a weaker instrument than the keyed
corpus and it is biased toward whatever the majority of the panel does, so it
is reported as agreement, never as truth -- and disagreements are printed in
full so they can be checked by eye.

    python bakeoff.py --sheet C:/path/sheet.png --entries 97
    python bakeoff.py --sheet ... --models gemini-2.5-flash-lite gpt-5.4-mini
"""
import argparse
import json
import re
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2

import apimart
import pricing
import sheet_task

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
CELL_W, CELL_H, COLS = 345, 87, 3

DEFAULT_MODELS = ["gemini-2.5-flash-lite", "gemini-3.6-flash",
                  "gpt-5.4-mini", "qwen3.6-flash"]

HANDLE_RE = re.compile(r"^[a-z][a-z0-9._-]{2,14}$")


def norm(h):
    return re.sub(r"[^a-z0-9._-]", "", (h or "").strip().lower().lstrip("@"))


def run_one(model_id, uri, n, key, tag):
    m = apimart.Model(model_id, key=key)
    prompt = sheet_task.prompt(n, 1, n)
    t0 = time.time()
    try:
        txt, meta = m.ask(prompt, [uri])
    except Exception as e:                      # noqa: BLE001 - a dead model is a result
        print(f"  {model_id:<24} ERROR {str(e)[:70]}", flush=True)
        return {"model": model_id, "error": str(e)[:400], "entries": []}
    got = sheet_task.entries_from(sheet_task.extract_json(txt))
    for i, e in enumerate(got):
        try:
            e["n"] = int(e.get("n"))
        except (TypeError, ValueError):
            e["n"] = i + 1
    out = {"model": model_id, "seconds": round(time.time() - t0, 1),
           "prompt_tokens": meta.get("prompt_tokens"),
           "completion_tokens": meta.get("completion_tokens"),
           "parsed": len(got), "entries": got, "raw": txt}
    RESULTS.mkdir(exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", model_id)
    (RESULTS / f"bakeoff_{slug}_{tag}.json").write_text(
        json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"  {model_id:<24} {out['seconds']:>6.1f}s  {len(got):>3}/{n} parsed  "
          f"in={out['prompt_tokens']} out={out['completion_tokens']}", flush=True)
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--entries", type=int, required=True)
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    ap.add_argument("--tag", default="live")
    a = ap.parse_args(argv)

    img = cv2.imread(a.sheet)
    if img is None:
        raise SystemExit(f"cannot read {a.sheet}")
    h, w = img.shape[:2]
    print(f"{a.sheet}  {w}x{h}  "
          f"{w // CELL_W} cols x {h // CELL_H} grid rows, "
          f"{a.entries} entries\n")

    uri = apimart.png_data_uri(img)
    key = apimart.api_key()
    with ThreadPoolExecutor(max_workers=len(a.models)) as ex:
        runs = list(ex.map(
            lambda m: run_one(m, uri, a.entries, key, a.tag), a.models))

    ok = [r for r in runs if r.get("entries")]
    if len(ok) < 2:
        raise SystemExit("need at least two models to form a consensus")

    # Consensus per position, then per handle.
    votes = {}
    for r in ok:
        for e in r["entries"]:
            n = e.get("n")
            if isinstance(n, int) and 1 <= n <= a.entries:
                votes.setdefault(n, Counter())[norm(e.get("handle"))] += 1

    ref = {}
    split = []
    for n in range(1, a.entries + 1):
        c = votes.get(n)
        if not c:
            continue
        handle, count = c.most_common(1)[0]
        ref[n] = handle
        if count < len(ok):
            split.append((n, c))

    print(f"\nconsensus over {len(ok)} models: {len(ref)} positions filled, "
          f"{len(ref) - len(split)} unanimous, {len(split)} split")

    print(f"\n{'model':<24}{'sec':>7}{'parsed':>8}{'agree':>8}"
          f"{'solo':>7}{'invalid':>9}{'$/1k':>9}")
    print("-" * 72)
    rows = []
    for r in ok:
        agree = solo = invalid = 0
        for e in r["entries"]:
            n, hh = e.get("n"), norm(e.get("handle"))
            if not HANDLE_RE.match(hh):
                invalid += 1
            if ref.get(n) == hh:
                agree += 1
            elif sum(1 for o in ok for oe in o["entries"]
                     if norm(oe.get("handle")) == hh) == 1:
                solo += 1
        usd = pricing.cost(r["model"], r["prompt_tokens"],
                           r["completion_tokens"])
        cost = usd / a.entries * 1000 if usd else None
        rows.append((r["model"], r["seconds"], r["parsed"], agree, solo,
                     invalid, cost))
        print(f"{r['model']:<24}{r['seconds']:>7.1f}{r['parsed']:>8}"
              f"{agree:>8}{solo:>7}{invalid:>9}"
              f"{('$%.3f' % cost) if cost else 'n/a':>9}")

    print("\nagree   = matches the panel consensus for that position")
    print("solo    = a handle no other model produced (likely invented)")
    print("invalid = not a possible Snapchat handle at all")

    if split:
        print(f"\npositions the panel split on ({len(split)}):")
        for n, c in split[:25]:
            print(f"  {n:>3}  {dict(c)}")

    (RESULTS / f"bakeoff_consensus_{a.tag}.json").write_text(
        json.dumps({"reference": ref, "models": [r["model"] for r in ok]},
                   indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\nreference written to results/bakeoff_consensus_{a.tag}.json")


if __name__ == "__main__":
    main(sys.argv[1:])
