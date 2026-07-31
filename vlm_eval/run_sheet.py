"""Run hosted models over the 99-entry contact sheet and record what they said.

Collection only -- scoring is score_sheet.py, so a run is never wasted when the
metrics change.

    python run_sheet.py --models gemini-2.5-flash gpt-5.4-mini
    python run_sheet.py --models gemini-2.5-flash --rows-per-call 11   # 3 calls
    python run_sheet.py --models gemini-2.5-flash --scale 2            # upscaled

`--rows-per-call` is the interesting knob. 33 (the default) is one call for the
whole sheet: cheapest, one image, but the model has to hold 99 lines of 13px
text in one glance and keep the numbering straight for all of them. Smaller
bands cost more calls and more image tokens in total, and the question is
whether they buy back enough accuracy to be worth it.

Models run concurrently, bands within a model run in order.
"""
import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import apimart
import sheet
import sheet_task

RESULTS = Path(__file__).resolve().parent / "results"


def save(run, label):
    """Written per model, not at the end of the batch: one model that hangs for
    its full timeout must not cost the other sixteen their results."""
    RESULTS.mkdir(exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", run["model"])
    p = RESULTS / f"sheet_{slug}_{label}.json"
    p.write_text(json.dumps(run, indent=1, ensure_ascii=False), encoding="utf-8")
    return p


def run_model(model_id, img, rows_per_call, scale, jpeg, key, temperature,
              label="r33"):
    m = apimart.Model(model_id, key=key, temperature=temperature)
    out = {"model": model_id, "rows_per_call": rows_per_call, "scale": scale,
           "entries": [], "calls": []}
    t_start = time.time()
    for start, count in sheet.bands(rows_per_call):
        ents = sheet.band_entries(start, count)
        crop = sheet.upscale(sheet.crop_band(img, start, count), scale)
        uri = (apimart.jpeg_data_uri(crop) if jpeg else apimart.png_data_uri(crop))
        prompt = sheet_task.prompt(len(ents), ents[0], ents[-1])
        call = {"entries": f"{ents[0]}-{ents[-1]}",
                "px": f"{crop.shape[1]}x{crop.shape[0]}"}
        try:
            txt, meta = m.ask(prompt, [uri])
        except Exception as e:                  # noqa: BLE001 - a dead model is a result
            call["error"] = str(e)[:400]
            out["calls"].append(call)
            print(f"  {model_id:<30} {call['entries']:>7}  ERROR {call['error'][:60]}",
                  flush=True)
            continue
        call.update(meta)
        call["raw"] = txt
        got = sheet_task.entries_from(sheet_task.extract_json(txt))
        call["parsed"] = len(got)
        # Unnumbered replies are assumed to be in the order asked for; that is
        # recorded so the scorer can tell a real position from an imputed one.
        for i, e in enumerate(got):
            try:
                e["n"] = int(e.get("n"))
            except (TypeError, ValueError):
                e["n"] = ents[i] if i < len(ents) else None
                e["_imputed_n"] = True
        out["entries"].extend(got)
        out["calls"].append(call)
        print(f"  {model_id:<30} {call['entries']:>7}  {meta['seconds']:6.1f}s  "
              f"{call['parsed']:>3}/{len(ents)} parsed  "
              f"in={meta.get('prompt_tokens')} out={meta.get('completion_tokens')}",
              flush=True)
    out["total_seconds"] = round(time.time() - t_start, 1)
    out["prompt_tokens"] = sum(c.get("prompt_tokens") or 0 for c in out["calls"])
    out["completion_tokens"] = sum(c.get("completion_tokens") or 0 for c in out["calls"])
    save(out, label)
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--rows-per-call", type=int, default=sheet.GRID_ROWS,
                    help="grid rows per call; 33 = the whole sheet in one call")
    ap.add_argument("--scale", type=int, default=1, help="upscale the crop NxN")
    ap.add_argument("--jpeg", action="store_true", help="send JPEG instead of PNG")
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--tag", default="", help="suffix for the result filename")
    a = ap.parse_args(argv)

    key = apimart.api_key()
    img = sheet.load_sheet()
    per = min(a.rows_per_call, sheet.GRID_ROWS)
    label = f"r{per}" + (f"_x{a.scale}" if a.scale != 1 else "") + \
            ("_jpg" if a.jpeg else "") + (f"_{a.tag}" if a.tag else "")
    print(f"{len(a.models)} models, {len(sheet.bands(per))} call(s) each, "
          f"mode {label}\n")

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        runs = list(ex.map(
            lambda m: run_model(m, img, per, a.scale, a.jpeg, key,
                                a.temperature, label),
            a.models))

    print(f"\nwrote {len(runs)} files to {RESULTS}")
    print(f"score them:\n  python score_sheet.py")


if __name__ == "__main__":
    main(sys.argv[1:])
