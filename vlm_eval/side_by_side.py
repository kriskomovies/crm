"""Full 99-row side-by-side of two runs, transcription and origin together.

The aggregate tables say 99/99 against 98/99 and "agrees on 79/99 origins".
Neither tells you whether the disagreements are ones you would care about. This
prints every row of both, marks the differences, and writes a file to keep.

Transcription is marked against the key, which exists. Origin is only ever marked
as a difference, because there is no key for it and neither model can be called
right -- one of them naming Danish where the other says American is a difference
in willingness to infer, not a scored error.

    python side_by_side.py sheet_gemini-3.6-flash_r33.json sheet_gpt-4.1-mini_r11.json
"""
import csv
import json
import sys
from pathlib import Path

import sheet
from score import norm_text, strip_emoji
from score_sheet import RESULTS, emoji_key, norm_handle

HERE = Path(__file__).resolve().parent
VAGUE = {"", "american", "unknown", "n/a", "none"}

DEFAULT_A = "sheet_gemini-3.6-flash_r33.json"
DEFAULT_B = "sheet_gpt-4.1-mini_r11.json"


def load(name):
    p = Path(name) if Path(name).exists() else RESULTS / name
    run = json.loads(p.read_text(encoding="utf-8"))
    return run, {e["n"]: e for e in run["entries"] if isinstance(e.get("n"), int)}


def main(argv):
    fa = argv[0] if argv else DEFAULT_A
    fb = argv[1] if len(argv) > 1 else DEFAULT_B
    run_a, a = load(fa)
    run_b, b = load(fb)
    roster = {r["n"]: r for r in sheet.roster()}

    rows = []
    for n in sorted(roster):
        w, ea, eb = roster[n], a.get(n, {}), b.get(n, {})
        ha = norm_handle(ea.get("handle")) == norm_handle(w["handle"])
        hb = norm_handle(eb.get("handle")) == norm_handle(w["handle"])
        na = norm_text(strip_emoji(ea.get("display_name"))) == norm_text(strip_emoji(w["display_name"]))
        nb = norm_text(strip_emoji(eb.get("display_name"))) == norm_text(strip_emoji(w["display_name"]))
        nat_a = str(ea.get("nationality", "")).strip().casefold()
        nat_b = str(eb.get("nationality", "")).strip().casefold()
        rows.append({
            "n": n, "display_name": w["display_name"], "handle": w["handle"],
            "a_handle_ok": ha, "b_handle_ok": hb,
            "a_name_ok": na, "b_name_ok": nb,
            "a_handle": ea.get("handle", ""), "b_handle": eb.get("handle", ""),
            "a_name": ea.get("display_name", ""), "b_name": eb.get("display_name", ""),
            "a_nat": nat_a, "b_nat": nat_b,
            "a_conf": str(ea.get("nationality_confidence", "")).casefold(),
            "b_conf": str(eb.get("nationality_confidence", "")).casefold(),
        })

    A, B = run_a["model"], run_b["model"]
    print(f"A = {A}  ({len(run_a['calls'])} call(s), {run_a.get('total_seconds')}s)")
    print(f"B = {B}  ({len(run_b['calls'])} call(s), {run_b.get('total_seconds')}s)\n")

    print(f"{'':3}{'#':>3}  {'name (key)':<24}{'origin A':<14}{'origin B':<14}{'note'}")
    print("-" * 88)
    flat = diff = agree = 0
    for r in rows:
        same_nat = r["a_nat"] == r["b_nat"]
        if same_nat:
            agree += 1
        elif r["a_nat"] not in VAGUE and r["b_nat"] in VAGUE:
            flat += 1
        elif r["a_nat"] != r["b_nat"]:
            diff += 1
        bad = not (r["b_handle_ok"] and r["b_name_ok"]
                   and r["a_handle_ok"] and r["a_name_ok"])
        if same_nat and not bad:
            continue                       # identical and both correct: nothing to see
        mark = ("!!" if not r["b_handle_ok"] or not r["a_handle_ok"]
                else "~" if bad else "  ")
        note = ""
        if not r["a_handle_ok"]:
            note = f"A handle {r['a_handle']!r} (key {r['handle']})"
        elif not r["b_handle_ok"]:
            note = f"B handle {r['b_handle']!r} (key {r['handle']})"
        elif not r["a_name_ok"]:
            note = f"A name {r['a_name']!r}"
        elif not r["b_name_ok"]:
            note = f"B name {r['b_name']!r}"
        elif r["b_nat"] in VAGUE:
            note = "B declined to infer"
        print(f"{mark:<3}{r['n']:>3}  {r['display_name'][:22]:<24}"
              f"{r['a_nat'][:12]:<14}{r['b_nat'][:12]:<14}{note}")

    print(f"\norigin: {agree}/99 identical, {flat} where B declined and A named one, "
          f"{diff} genuinely different")
    for label, run, key in ((f"A {A}", run_a, "a"), (f"B {B}", run_b, "b")):
        h = sum(1 for r in rows if r[f"{key}_handle_ok"])
        nm = sum(1 for r in rows if r[f"{key}_name_ok"])
        calls = sum(1 for r in rows if r[f"{key}_nat"] not in VAGUE)
        print(f"  {label:<34} handles {h}/99   names {nm}/99   origin calls {calls}")

    out = HERE / "side_by_side.csv"
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"\n-> {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
