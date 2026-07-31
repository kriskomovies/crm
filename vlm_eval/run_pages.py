"""Run hosted models over the raw ../pages screenshots instead of the contact sheet.

Tests one hypothesis: **do models read better when asked for fewer entries at a
time?** The contact sheet asks for 99 in one call (or 33 in three). A page asks
for 14.

Worth being precise about what does and does not change. The glyph size is
IDENTICAL -- the contact sheet is a 1:1 crop montage of these very pages, so a
lowercase handle letter is 9px tall in both and a digit 13px in both. Nothing
here gives the model more pixels per character. The only variable is how many
entries it has to track at once, and whether it is looking at a 3-wide grid or a
single column.

The pages overlap, because they are a scrolling capture: 9 pages x 14 rows = 126
row-slots covering 99 unique handles. Scoring reports both, since the per-row
number measures reading and the per-handle number is what a caller actually gets.

    python run_pages.py --models gpt-5.1 gpt-4.1-mini
    python run_pages.py --models gpt-5.2 --crop text     # drop the avatar column
"""
import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import apimart
import rows as rowlib
import sheet_task

RESULTS = Path(__file__).resolve().parent / "results"


def run_model(model_id, pages, crop, key, temperature, label):
    m = apimart.Model(model_id, key=key, temperature=temperature)
    out = {"model": model_id, "mode": label, "crop": crop,
           "pages": {}, "calls": []}
    t0 = time.time()
    n = rowlib.ROWS_PER_PAGE
    for name in pages:
        img = rowlib.load_page(name)
        band = rowlib.crop_band(img, 0, n, crop)
        uri = apimart.png_data_uri(band)
        call = {"page": name, "px": f"{band.shape[1]}x{band.shape[0]}"}
        try:
            txt, meta = m.ask(sheet_task.list_prompt(n), [uri])
        except Exception as e:                  # noqa: BLE001 - a dead model is a result
            call["error"] = str(e)[:300]
            out["calls"].append(call)
            out["pages"][name] = []
            print(f"  {model_id:<24} {name}  ERROR {call['error'][:60]}", flush=True)
            continue
        call.update(meta)
        call["raw"] = txt
        got = sheet_task.entries_from(sheet_task.extract_json(txt))
        for i, e in enumerate(got):
            try:
                e["n"] = int(e.get("n"))
            except (TypeError, ValueError):
                e["n"] = i + 1
        call["parsed"] = len(got)
        out["pages"][name] = got
        out["calls"].append(call)
        print(f"  {model_id:<24} {name}  {meta['seconds']:5.1f}s  "
              f"{len(got)}/{n} parsed  in={meta.get('prompt_tokens')} "
              f"out={meta.get('completion_tokens')}", flush=True)
    out["total_seconds"] = round(time.time() - t0, 1)
    out["prompt_tokens"] = sum(c.get("prompt_tokens") or 0 for c in out["calls"])
    out["completion_tokens"] = sum(c.get("completion_tokens") or 0 for c in out["calls"])
    RESULTS.mkdir(exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", model_id)
    p = RESULTS / f"pages_{slug}_{label}.json"
    p.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--crop", choices=["full", "text"], default="full",
                    help="text drops the avatar and Add button, ~1/3 the pixels")
    ap.add_argument("--pages", nargs="*", default=["all"])
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--tag", default="")
    a = ap.parse_args(argv)

    pages = rowlib.page_names() if a.pages == ["all"] else a.pages
    label = f"p14-{a.crop}" + (f"_{a.tag}" if a.tag else "")
    key = apimart.api_key()
    print(f"{len(a.models)} models x {len(pages)} pages "
          f"({rowlib.ROWS_PER_PAGE} entries per call), crop={a.crop}\n")

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        runs = list(ex.map(
            lambda m: run_model(m, pages, a.crop, key, a.temperature, label),
            a.models))
    print(f"\nwrote {len(runs)} files to {RESULTS}")
    print("score them:\n  python score_pages.py")


if __name__ == "__main__":
    main(sys.argv[1:])
