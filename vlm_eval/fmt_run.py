"""Run both models over the format variants and score them against the key.

    python fmt_run.py                      # everything not already on disk
    python fmt_run.py --plan               # what it would spend, no calls
    python fmt_run.py --models ... --variants V2 V3
    python fmt_run.py --force              # re-pay for runs already on disk

THIS SPENDS REAL MONEY. One (model, variant) pair is one unit of work; a pair
already written under results/fmt/ is SKIPPED unless --force, so an interrupted
matrix resumes instead of re-buying what it already has.

WHAT IS BEING BOUGHT
--------------------
fmt_build.py laid out a 2x2: entries per image (99 vs 33) crossed with cell
width (345 native vs ~690 interpolated). V1 vs V4 holds entries constant and
doubles the pixels; V3 vs V4 holds the cell width and cuts the entries. Nothing
on disk separated those two changes before, because every prior run moved both.

V1 IS NOT RE-BOUGHT. results/golden_<model>.json is already the live production
prompt over sheet.load_sheet(), and fmt_build verified v1_99e_3c_345px is
byte-identical to that source image. Paying for it again would buy a second
sample of the same cell, not a new cell.

ALIGNMENT ACROSS BANDS
----------------------
The production prompt numbers every image 1..n from its own top-left, so a
33-entry band comes back numbered 1..33 three times over. Each reply's `n` is
remapped through the manifest's `positions` to the 1-based roster position it
actually is, and the three bands are concatenated into one 99-entry run. Only
then is it scored -- so a banded run and a single-image run are graded by the
same code against the same key, which is the only way the two are comparable.

SCORING IS BORROWED, NOT REWRITTEN
----------------------------------
golden_eval.score() is called verbatim: it aligns the judgement fields by
HANDLE (so a numbering slip is not scored as a gender bug), and it models
normalize.ts combinePresents exactly -- the avatar wins outright, and a woman is
rescued only when the NAME positively reads female. `leaked` is that routing
decision, which is the number that decides money. Display-name comparison
borrows field_verdict.strip_emoji for the same reason: a dropped emoji is a
rendering difference, not a misread, and counting it would bury real errors.

COST
----
Measured off pricing.balance_units() either side of each call, which is a single
global counter -- so every call here is serial and nothing else may be in
flight. The table price from pricing.cost() is recorded alongside as a check,
never as a substitute. A call whose measurement fails records null, not a guess.
"""
import argparse
import io
import json
import re
import sys
import time
from pathlib import Path

import apimart
import field_verdict
import golden_eval
import pricing
import prod_prompt
import sheet
import sheet_task

# stdout is cp1252 on this machine and 22 of the 122 keyed display names are not
# ASCII. Without this the table dies on an emoji AFTER the calls are paid for.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
OUT = HERE / "results" / "fmt"
MANIFEST = HERE / "results" / "fmt_manifest.json"
MODELS = ["gemini-3-flash-preview-nothinking", "gemini-3.6-flash"]

# V4 first: it is the 4.6 MB payload, so if the gateway refuses a ~6.2 MB data
# URI we find out on the cheap model before buying three bands of anything.
ORDER = ["V4", "V2", "V3"]

MAX_TOKENS = 32000          # matches apimart.Model default and gateway.client.ts


def slug(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s)


def data_uri(path):
    """The PNG bytes as written, not a re-encode -- what is sent is the artefact."""
    import base64
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def one_call(model_id, key, img_meta, cols):
    """One image -> (entries remapped to roster positions, call record)."""
    n = img_meta["n_entries"]
    positions = img_meta["positions"]
    prompt = prod_prompt.sheet_prompt(n, cols)

    before = None
    try:
        before = pricing.balance_units()
    except Exception:                                       # noqa: BLE001
        pass
    t0 = time.time()
    txt, meta = apimart.Model(model_id, key=key).ask(prompt, [data_uri(Path(img_meta["path"]))])
    secs = round(time.time() - t0, 1)
    # Let the counter settle. golden_eval.py uses 2s; that was not enough here --
    # the nothinking V2 arm read +$0.2550 on one call and -$0.1043 on the next,
    # and a NEGATIVE delta is proof the counter is not settled rather than proof
    # of a refund. 5s (measure_models.py uses 4) for the arms bought after that.
    # A per-call figure from a window containing a negative delta is reported as
    # unreliable, not smoothed.
    time.sleep(5)
    usd = None
    try:
        if before is not None:
            usd = (pricing.balance_units() - before) / pricing.UNITS_PER_USD
    except Exception:                                       # noqa: BLE001
        pass

    parsed = sheet_task.extract_json(txt)
    got = sheet_task.entries_from(parsed)
    salvaged = bool(isinstance(parsed, dict) and parsed.get("_salvaged"))

    # Remap slot -> roster position. A model that emits more entries than the
    # image holds is padding (V2 has one blank cell per image); those are dropped
    # rather than mapped onto somebody.
    out, extra = [], 0
    for i, e in enumerate(got):
        try:
            slot = int(e.get("n"))
        except (TypeError, ValueError):
            slot = i + 1
        if not 1 <= slot <= len(positions):
            extra += 1
            continue
        out.append(e | {"n": positions[slot - 1], "slot": slot,
                        "image": img_meta["file"]})

    rec = {"image": img_meta["file"], "n_entries": n, "cols": cols,
           "seconds": secs, "measured_usd": usd,
           "prompt_tokens": meta.get("prompt_tokens"),
           "completion_tokens": meta.get("completion_tokens"),
           "image_tokens": meta.get("image_tokens"),
           "finish_reason": meta.get("finish_reason"),
           "salvaged": salvaged, "off_grid_entries": extra,
           "parsed": len(out), "prompt_chars": len(prompt), "raw": txt}
    flag = ""
    if salvaged:
        flag += "  SALVAGED"
    if (rec["completion_tokens"] or 0) >= MAX_TOKENS - 50:
        flag += "  CEILING"
    if extra:
        flag += f"  +{extra} off-grid"
    print(f"    {img_meta['file']:<32}{secs:>7.1f}s  {len(out):>3}/{n} parsed  "
          f"in={rec['prompt_tokens']} out={rec['completion_tokens']}  "
          f"{('$%.4f' % usd) if usd is not None else 'n/a':>9}{flag}")
    return out, rec


def run_variant(model_id, variant, key):
    entries, calls = [], []
    for im in variant["images"]:
        got, rec = one_call(model_id, key, im, variant["cols"])
        entries.extend(got)
        calls.append(rec)

    usds = [c["measured_usd"] for c in calls]
    total_usd = sum(usds) if all(u is not None for u in usds) else None
    return {
        "model": model_id, "variant": variant["tag"], "role": variant["role"],
        "entries_per_image": variant["entries_per_image"],
        "cols": variant["cols"], "cell_w": variant["cell_w"],
        "cell_h": variant["cell_h"], "scale": variant["scale"],
        "rescaled": variant["rescaled"], "interp": variant["interp"],
        "calls": len(calls),
        "seconds": round(sum(c["seconds"] for c in calls), 1),
        "measured_usd": total_usd,
        "prompt_tokens": sum(c["prompt_tokens"] or 0 for c in calls),
        "completion_tokens": sum(c["completion_tokens"] or 0 for c in calls),
        "table_usd": pricing.cost(model_id,
                                  sum(c["prompt_tokens"] or 0 for c in calls),
                                  sum(c["completion_tokens"] or 0 for c in calls)),
        "call_records": [{k: v for k, v in c.items() if k != "raw"} for c in calls],
        "entries": entries,
        "raw": {c["image"]: c["raw"] for c in calls},
    }


def load_v1(model_id):
    """The existing production-prompt run over the native 99-cell sheet."""
    p = HERE / "results" / f"golden_{slug(model_id)}.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text(encoding="utf-8"))
    return {"model": model_id, "variant": "V1",
            "role": "control -- production geometry, native pixels",
            "entries_per_image": 99, "cols": 3, "cell_w": 345, "cell_h": 87,
            "scale": 1.0, "rescaled": False, "interp": None, "calls": 1,
            "seconds": d["seconds"], "measured_usd": d["measured_usd"],
            "prompt_tokens": d["prompt_tokens"],
            "completion_tokens": d["completion_tokens"],
            "table_usd": pricing.cost(model_id, d["prompt_tokens"],
                                      d["completion_tokens"]),
            "reused_from": str(p), "call_records": [], "entries": d["entries"]}


def score(run_out, gt, roster):
    """golden_eval.score plus the two fields it does not carry."""
    s = golden_eval.score(run_out, gt, roster)
    by_n = {e["n"]: e for e in run_out["entries"]}
    name_ok = anglo = unknown = 0
    for r in roster:
        e = by_n.get(r["n"], {})
        if field_verdict.strip_emoji(e.get("display_name")) == \
                field_verdict.strip_emoji(r["display_name"]):
            name_ok += 1
        nat = field_verdict.norm(e.get("nationality"))
        anglo += nat in field_verdict.ANGLO
        unknown += nat in ("", "unknown")
    return s | {"name_ok": name_ok, "anglo": anglo, "nat_unknown": unknown,
                "parsed": len(run_out["entries"])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=MODELS)
    ap.add_argument("--variants", nargs="*", default=["V1"] + ORDER)
    ap.add_argument("--force", action="store_true",
                    help="re-pay for pairs already written under results/fmt/")
    ap.add_argument("--plan", action="store_true", help="no calls, no money")
    a = ap.parse_args()

    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    by_tag = {v["tag"]: v for v in man["variants"]}
    gt = golden_eval.key_by_handle()
    roster = sheet.roster()
    n_all = len(roster)
    OUT.mkdir(parents=True, exist_ok=True)

    todo = [(m, t) for m in a.models for t in a.variants]
    if a.plan:
        print(f"{'model':<38}{'var':>5}{'calls':>7}  action")
        for m, t in todo:
            f = OUT / f"run_{slug(m)}_{t}.json"
            act = ("reuse golden_*.json" if t == "V1" else
                   "ON DISK, skip" if f.exists() and not a.force else "PAY")
            print(f"{m:<38}{t:>5}{by_tag[t]['n_images']:>7}  {act}")
        return 0

    results = []
    for model_id in a.models:
        key = apimart.api_key()
        for tag in a.variants:
            f = OUT / f"run_{slug(model_id)}_{tag}.json"
            if tag == "V1":
                r = load_v1(model_id)
                if r is None:
                    print(f"!! no golden run for {model_id}; V1 skipped")
                    continue
                print(f"\n{model_id}  {tag}  REUSED {Path(r['reused_from']).name}")
                results.append(r)
                continue
            if f.exists() and not a.force:
                print(f"\n{model_id}  {tag}  already on disk, not re-paying")
                results.append(json.loads(f.read_text(encoding="utf-8")))
                continue
            v = by_tag[tag]
            print(f"\n{model_id}  {tag}  {v['entries_per_image']}e x {v['cols']}c "
                  f"cell {v['cell_w']}px  {v['n_images']} call(s)")
            try:
                r = run_variant(model_id, v, key)
            except Exception as e:                          # noqa: BLE001
                print(f"!! {model_id} {tag} FAILED: {type(e).__name__}: "
                      f"{str(e)[:300]}")
                continue
            f.write_text(json.dumps(r, indent=1, ensure_ascii=False),
                         encoding="utf-8")
            results.append(r)

    scored = [(r, score(r, gt, roster)) for r in results]

    print(f"\n{'model':<34}{'var':>4}{'cell':>6}{'e/img':>6}{'calls':>6}"
          f"{'hndl':>7}{'name':>7}{'avatar':>8}{'women ok':>10}{'LEAKED':>8}"
          f"{'anglo':>7}{'unk':>5}{'out tok':>9}{'$/sheet':>10}{'$/1000':>9}{'sec':>7}")
    print("-" * 143)
    for r, s in scored:
        av = s["avatar"]
        u = r["measured_usd"]
        women_ok = sum(1 for w in s["women"] if w[2] == "woman")
        hndl = "%d/%d" % (s["handles_pos"], n_all)
        name = "%d/%d" % (s["name_ok"], n_all)
        avat = "%d/%d" % (av["right"], av["right"] + av["wrong"])
        wok = "%d/5" % women_ok
        leak = "%d/5" % len(s["leaked"])
        usd = ("$%.4f" % u) if u is not None else "n/a"
        per_k = ("$%.3f" % (u / n_all * 1000)) if u is not None else "n/a"
        print(f"{r['model']:<34}{r['variant']:>4}{r['cell_w']:>6}"
              f"{r['entries_per_image']:>6}{r['calls']:>6}"
              f"{hndl:>7}{name:>7}{avat:>8}{wok:>10}{leak:>8}"
              f"{s['anglo']:>7}{s['nat_unknown']:>5}"
              f"{r['completion_tokens']:>9}{usd:>10}{per_k:>9}"
              f"{r['seconds']:>7.1f}")

    print("\nthe five women, per run (sample size is 5, whole stop)")
    for r, s in scored:
        print(f"\n  {r['model']}  {r['variant']}")
        for h, dn, avv, nm, fate in s["women"]:
            print(f"    {h:<18}{(dn or '')[:16]:<18}avatar={str(avv):<12}"
                  f"name={str(nm):<11}{fate}")

    paid = [r["measured_usd"] for r in results
            if r["measured_usd"] is not None and "reused_from" not in r]
    print(f"\nspend this session (V1 reused, not re-bought): ${sum(paid):.4f} "
          f"over {sum(r['calls'] for r in results if 'reused_from' not in r)} calls")
    return 0


if __name__ == "__main__":
    sys.exit(main())
