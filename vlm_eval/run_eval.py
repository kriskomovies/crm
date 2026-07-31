"""Run a vision model over the Quick Add screenshots and record what it said.

Scoring lives in score.py -- this script only collects predictions, so a slow
run is never wasted and the same predictions can be re-scored as the ground
truth is corrected.

    # whole page in one call (hard mode: 14 rows of 20px text at once)
    python run_eval.py --provider hf:Qwen/Qwen2.5-VL-3B-Instruct --mode page

    # one call per cropped row (easy mode, 14x the calls)
    python run_eval.py --provider ollama:qwen2.5vl:7b --mode row

    # against LM Studio / llama.cpp / vLLM
    python run_eval.py --provider openai:my-model --base http://localhost:1234

Writes results/<provider>_<mode>_<task>.json.
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

import providers
import rows as rowlib
import tasks

RESULTS = Path(__file__).resolve().parent / "results"


def _run_page(prov, prompt, page_img, task, n):
    t0 = time.time()
    raw = prov.ask(prompt, [page_img])
    dt = time.time() - t0
    parsed = tasks.extract_json(raw)
    out = []
    if isinstance(parsed, dict) and isinstance(parsed.get("rows"), list):
        for i, r in enumerate(parsed["rows"][:n]):
            if isinstance(r, dict):
                r.setdefault("position", i + 1)
                out.append(r)
    return out, [{"raw": raw, "seconds": round(dt, 2), "parsed": bool(out)}]


def _run_bands(prov, page_img, task, n, per_call, crop):
    """One call per band of `per_call` rows. per_call=1 is the old row mode."""
    out, calls = [], []
    for start, count in rowlib.bands(per_call):
        prompt = tasks.band_prompt(task, count)
        img = rowlib.crop_band(page_img, start, count, crop)
        t0 = time.time()
        try:
            raw = prov.ask(prompt, [img])
        except RuntimeError as e:
            raw = f"<<error: {e}>>"
        dt = time.time() - t0
        parsed = tasks.extract_json(raw)
        got = []
        if isinstance(parsed, dict):
            # A 1-row band answers with a bare object; a multi-row band wraps in
            # "rows". Accept either so per_call=1 stays comparable to row mode.
            items = parsed["rows"] if isinstance(parsed.get("rows"), list) else [parsed]
            for j, r in enumerate(items[:count]):
                if isinstance(r, dict):
                    # Renumber from the band's offset back to page coordinates.
                    r["position"] = start + j + 1
                    got.append(r)
        out.extend(got)
        calls.append({"band": f"{start + 1}-{start + count}", "raw": raw,
                      "seconds": round(dt, 2), "parsed": len(got) == count})
        print(f"    rows {start + 1:2d}-{start + count:<2d}  {dt:5.1f}s  "
              f"{len(got)}/{count}", flush=True)
    return out, calls


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", required=True,
                    help='backend:model, e.g. hf:Qwen/Qwen2.5-VL-3B-Instruct')
    ap.add_argument("--mode", choices=["page", "row", "band"], default="row",
                    help="page: one call for the whole screenshot. row: one call "
                         "per cropped row. band: one call per --rows-per-call rows")
    ap.add_argument("--rows-per-call", type=int, default=3,
                    help="band mode: rows per call (14 = the whole list, cropped)")
    ap.add_argument("--crop", choices=["full", "text"], default="full",
                    help="full keeps the avatar; text keeps only the name/handle "
                         "column, which is ~1/3 the pixels")
    ap.add_argument("--task", choices=["read", "avatar", "both"], default="both")
    ap.add_argument("--pages", nargs="*", default=["page_00"],
                    help='page stems, or "all"')
    ap.add_argument("--base", default="http://localhost:1234", help="openai backend base URL")
    ap.add_argument("--host", default="http://localhost:11434", help="ollama host")
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--4bit", dest="load_4bit", action="store_true",
                    help="hf backend: quantise to 4-bit so a 7B fits in 8GB VRAM")
    a = ap.parse_args(argv)

    prov = providers.build(a.provider, base=a.base, host=a.host,
                           temperature=a.temperature, load_4bit=a.load_4bit)
    pages = rowlib.page_names() if a.pages == ["all"] else a.pages
    n = rowlib.ROWS_PER_PAGE
    per_call = 1 if a.mode == "row" else a.rows_per_call

    label = a.mode
    if a.mode == "band":
        label = f"band{per_call}-{a.crop}"
    elif a.mode == "row":
        label = f"row-{a.crop}"

    print(f"provider : {prov.name()}\nmode     : {label}\ntask     : {a.task}\n"
          f"pages    : {', '.join(pages)}\n")

    result = {"provider": prov.name(), "mode": label, "task": a.task,
              "rows_per_call": None if a.mode == "page" else per_call,
              "crop": None if a.mode == "page" else a.crop,
              "fields": tasks.fields_for(a.task), "pages": {}}
    t_start = time.time()
    for name in pages:
        print(f"  {name}")
        page_img = rowlib.load_page(name)
        if a.mode == "page":
            predicted, calls = _run_page(prov, tasks.page_prompt(a.task, n),
                                         page_img, a.task, n)
        else:
            predicted, calls = _run_bands(prov, page_img, a.task, n, per_call, a.crop)
        result["pages"][name] = {"rows": predicted, "calls": calls}
        print(f"    -> {len(predicted)}/{n} rows parsed\n")
    result["total_seconds"] = round(time.time() - t_start, 1)

    RESULTS.mkdir(exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", prov.name())
    path = RESULTS / f"{slug}_{label}_{a.task}.json"
    path.write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{result['total_seconds']}s total -> {path}")
    print(f"\nscore it:\n  python score.py {path.name}")


if __name__ == "__main__":
    main(sys.argv[1:])
