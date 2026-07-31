"""Cheap triage: which of the gateway's models can read this sheet at all?

Sends the first two grid rows (6 entries, 1035x174) to every candidate and
reports whether it answered, how fast, and how many of the 6 names and handles
it got exactly right. The point is to spend a few cents finding the models worth
a full 99-entry run, rather than paying for 99 entries on a model that turns out
to be text-only.

    python probe.py                  # default candidate list
    python probe.py gpt-5.4-mini gemini-3.6-flash
"""
import json
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import apimart
import sheet
import sheet_task

RESULTS = Path(__file__).resolve().parent / "results"

CANDIDATES = [
    # Gemini -- historically the strongest cheap OCR
    "gemini-3-flash-preview", "gemini-3.5-flash", "gemini-3.6-flash",
    "gemini-3.1-flash-lite-preview", "gemini-3.1-pro-preview",
    "gemini-3-pro-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    # OpenAI
    "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5-mini", "gpt-5.1", "gpt-5.2",
    "gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1",
    # Anthropic
    "claude-haiku-4-5-20251001", "claude-sonnet-4-6",
    # everyone else
    "qwen3.6-plus", "qwen3.6-flash", "qwen3.7-plus", "grok-4.5",
    "glm-5", "step-3.7-flash", "kimi-k2.5", "minimax-m2.5", "deepseek-ocr",
    "mimo-v2.5-pro",
]

N_ROWS = 2   # grid rows -> 6 entries


def strip_emoji(s):
    """Compare names on their text only.

    Emoji are a separate skill from reading letters and every model in the
    earlier local eval dropped them, so folding the two together would hide
    whether a model can transcribe at all. Scored separately, not ignored.
    """
    out = []
    for ch in str(s or ""):
        if unicodedata.category(ch) in ("So", "Sk", "Cf", "Cn", "Co"):
            continue
        out.append(ch)
    return " ".join("".join(out).split())


def probe(model_id, img_uri, prompt, key, want):
    row = {"model": model_id}
    try:
        m = apimart.Model(model_id, key=key)
        txt, meta = m.ask(prompt, [img_uri])
    except Exception as e:                      # noqa: BLE001 - triage reports, never crashes
        row["error"] = str(e)[:200]
        return row
    row.update(meta)
    got = sheet_task.entries_from(sheet_task.extract_json(txt))
    row["parsed"] = len(got)
    row["raw_head"] = txt.strip()[:180]
    by_n = {}
    for e in got:
        try:
            by_n[int(e.get("n"))] = e
        except (TypeError, ValueError):
            continue
    if not by_n:                                # unnumbered but ordered
        by_n = {w["n"]: e for w, e in zip(want, got)}
    name_hit = handle_hit = 0
    for w in want:
        e = by_n.get(w["n"], {})
        if strip_emoji(e.get("display_name")).casefold() == strip_emoji(w["display_name"]).casefold():
            name_hit += 1
        if str(e.get("handle", "")).strip().casefold() == w["handle"].casefold():
            handle_hit += 1
    row["name_ok"] = name_hit
    row["handle_ok"] = handle_hit
    row["nat"] = [str(by_n.get(w["n"], {}).get("nationality", "")) for w in want]
    return row


def main(argv):
    models = argv or CANDIDATES
    key = apimart.api_key()
    img = sheet.crop_band(sheet.load_sheet(), 0, N_ROWS)
    ents = sheet.band_entries(0, N_ROWS)
    want = [r for r in sheet.roster() if r["n"] in ents]
    uri = apimart.png_data_uri(img)
    prompt = sheet_task.prompt(len(ents), ents[0], ents[-1])

    print(f"probing {len(models)} models on entries {ents[0]}-{ents[-1]} "
          f"({img.shape[1]}x{img.shape[0]})\n")
    with ThreadPoolExecutor(max_workers=8) as ex:
        rows = list(ex.map(lambda m: probe(m, uri, prompt, key, want), models))

    rows.sort(key=lambda r: (-r.get("name_ok", -1), -r.get("handle_ok", -1),
                             r.get("seconds", 9e9)))
    print(f"{'model':<34} {'sec':>6} {'in':>7} {'out':>6}  n/6  h/6  note")
    print("-" * 88)
    for r in rows:
        if "error" in r:
            print(f"{r['model']:<34} {'--':>6} {'--':>7} {'--':>6}   -    -   "
                  f"ERR {r['error'][:34]}")
            continue
        print(f"{r['model']:<34} {r['seconds']:>6.1f} "
              f"{str(r.get('prompt_tokens') or '?'):>7} "
              f"{str(r.get('completion_tokens') or '?'):>6} "
              f"{r['name_ok']:>4} {r['handle_ok']:>4}  "
              f"parsed {r['parsed']}/{len(want)}"
              + (f"  quirks={','.join(r['quirks'])}" if r.get("quirks") else ""))

    RESULTS.mkdir(exist_ok=True)
    p = RESULTS / "apimart_probe.json"
    p.write_text(json.dumps({"entries": ents, "want": want, "rows": rows},
                            indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n-> {p}")


if __name__ == "__main__":
    main(sys.argv[1:])
