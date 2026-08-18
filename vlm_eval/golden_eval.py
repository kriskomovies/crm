"""Both candidate models over the 99-entry golden sheet, scored against the key.

Everything measured on the fresh 33-person roster was AGREEMENT between two
models, which cannot separate "both right" from "both wrong the same way". This
sheet has a hand-keyed answer for all 99 entries, so the same fields come back
as right or wrong.

It also covers the case the 33-person roster structurally could not: that
roster was 30 men and 3 placeholders, and the error that costs real money is a
WOMAN forwarded to a client who asked for men. There are five women here.

The routing consequence is modelled exactly as the server does it. From
normalize.ts, combinePresents lets the avatar win outright, and signalsDisagree
only rescues a profile when the NAME positively reads female; so a woman whose
cartoon is read as a man, with a name that reads male or ambiguous, is
forwarded with nothing left to catch her. That specific sequence is what is
counted, not just the raw field accuracy.

Entries are aligned by HANDLE rather than by position. Position alignment
silently corrupts every judgement field downstream of a single numbering slip,
which would score a numbering bug as a gender bug.
"""
import json
import re
import sys
import time
from pathlib import Path

import apimart
import pricing
import prod_prompt
import sheet
import sheet_task

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
MODELS = ["gemini-3-flash-preview-nothinking", "gemini-3.6-flash"]
TONES = ["pale", "light", "light-tan", "medium-tan", "tan", "brown", "dark-brown"]


def key_by_handle():
    """handle -> ground-truth row, first sighting wins (pages overlap)."""
    gt = json.loads((HERE / "ground_truth.json").read_text(encoding="utf-8"))
    out = {}
    for page in sorted(gt["pages"]):
        for r in gt["pages"][page]:
            out.setdefault(r["handle"].strip().lower(), r)
    return out


def norm(s):
    return (s or "").strip().lower()


def presents(s):
    v = norm(s).replace("_", "-")
    return {"male": "man", "female": "woman", "unclear": "ambiguous",
            "notaperson": "not-a-person", "none": "not-a-person"}.get(v, v)


def run(model_id, uri, key, n, cols):
    before = None
    try:
        before = pricing.balance_units()
    except Exception:                                   # noqa: BLE001
        pass
    t0 = time.time()
    txt, meta = apimart.Model(model_id, key=key).ask(
        prod_prompt.sheet_prompt(n, cols), [uri])
    secs = round(time.time() - t0, 1)
    time.sleep(2)
    usd = None
    try:
        if before is not None:
            usd = (pricing.balance_units() - before) / pricing.UNITS_PER_USD
    except Exception:                                   # noqa: BLE001
        pass
    got = sheet_task.entries_from(sheet_task.extract_json(txt))
    for i, e in enumerate(got):
        try:
            e["n"] = int(e.get("n"))
        except (TypeError, ValueError):
            e["n"] = i + 1
    out = {"model": model_id, "seconds": secs, "measured_usd": usd,
           "prompt_tokens": meta.get("prompt_tokens"),
           "completion_tokens": meta.get("completion_tokens"),
           "entries": got}
    RESULTS.mkdir(exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", model_id)
    (RESULTS / f"golden_{slug}.json").write_text(
        json.dumps(out | {"raw": txt}, indent=1, ensure_ascii=False),
        encoding="utf-8")
    print(f"  {model_id:<38}{secs:>7.1f}s  {len(got):>3}/{n} parsed  "
          f"{('$%.4f' % usd) if usd else 'n/a':>9}")
    return out


def score(run_out, gt, roster):
    ents = run_out["entries"]
    by_pos = {e["n"]: e for e in ents}
    roster_h = [r["handle"].strip().lower() for r in roster]
    rset = set(roster_h)

    # Handle transcription, judged positionally: this is the field the follower
    # acts on, so being right about someone in the wrong slot is not enough.
    hit = sum(1 for i, h in enumerate(roster_h, 1)
              if norm(by_pos.get(i, {}).get("handle")) == h)
    inset = sum(1 for e in ents if norm(e.get("handle")) in rset)

    # Judgement fields, aligned by handle.
    av = {"right": 0, "wrong": 0, "missing": 0}
    tone_exact = tone_near = tone_n = 0
    women, leaked = [], []
    for r in roster:
        h = r["handle"].strip().lower()
        g = gt.get(h, {})
        e = next((x for x in ents if norm(x.get("handle")) == h), None)
        truth = presents(g.get("gender_presentation"))
        if e is None:
            av["missing"] += 1
            if truth == "woman":
                women.append((h, r["display_name"], None, None, "NOT READ"))
            continue
        got_av = presents(e.get("avatar_presents_as"))
        got_nm = presents(e.get("name_presents_as"))
        if got_av == truth:
            av["right"] += 1
        else:
            av["wrong"] += 1
        if truth == "woman":
            # combinePresents: the avatar wins. signalsDisagree only saves her
            # if the NAME positively reads female.
            routed = got_av if got_av in ("man", "woman", "not-a-person") \
                else (got_nm or "ambiguous")
            dropped = got_av in ("man", "woman") and got_nm in ("man", "woman") \
                and got_av != got_nm
            fate = "DROPPED (signals disagree)" if dropped else \
                ("FORWARDED AS MAN" if routed == "man" else f"routed {routed}")
            women.append((h, r["display_name"], got_av, got_nm, fate))
            if routed == "man" and not dropped:
                leaked.append(h)
        t_true, t_got = norm(g.get("skin_tone")), norm(e.get("skin_tone"))
        if t_true in TONES and t_got in TONES:
            tone_n += 1
            tone_exact += t_true == t_got
            tone_near += abs(TONES.index(t_true) - TONES.index(t_got)) <= 1
    return {"handles_pos": hit, "handles_inset": inset, "avatar": av,
            "tone_exact": tone_exact, "tone_near": tone_near, "tone_n": tone_n,
            "women": women, "leaked": leaked}


def main():
    gt = key_by_handle()
    roster = sheet.roster()
    img = sheet.load_sheet()
    n, cols = sheet.N_ENTRIES, sheet.COLS
    print(f"golden sheet {img.shape[1]}x{img.shape[0]}  {n} entries, {cols} cols"
          f"\nground truth: {len(gt)} handles, "
          f"{sum(1 for r in roster if presents(gt.get(r['handle'].strip().lower(), {}).get('gender_presentation')) == 'woman')}"
          f" women in the 99\n")
    uri = apimart.png_data_uri(img)
    key = apimart.api_key()

    runs = [run(m, uri, key, n, cols) for m in MODELS]
    scored = [(r, score(r, gt, roster)) for r in runs]

    print(f"\n{'':<38}{'handle@pos':>12}{'in-set':>8}{'avatar ok':>11}"
          f"{'tone=':>7}{'tone±1':>8}{'women leaked':>14}")
    print("-" * 98)
    for r, s in scored:
        a = s["avatar"]
        tot = a["right"] + a["wrong"]
        pos = f"{s['handles_pos']}/{n}"
        avat = f"{a['right']}/{tot}"
        near = f"{s['tone_near']}/{s['tone_n']}"
        print(f"{r['model']:<38}{pos:>12}{s['handles_inset']:>8}{avat:>11}"
              f"{s['tone_exact']:>7}{near:>8}{len(s['leaked']):>14}")

    for r, s in scored:
        print(f"\n{'=' * 78}\n{r['model']} -- the five women\n{'=' * 78}")
        for h, dn, av, nm, fate in s["women"]:
            print(f"  {h:<22}{(dn or '')[:18]:<20}avatar={str(av):<12}"
                  f"name={str(nm):<11}{fate}")

    print(f"\n{'model':<38}{'sec':>7}{'in':>7}{'out':>7}{'$/sheet':>10}"
          f"{'$/1000':>9}")
    print("-" * 78)
    for r in runs:
        u = r["measured_usd"]
        print(f"{r['model']:<38}{r['seconds']:>7.1f}{r['prompt_tokens']:>7}"
              f"{r['completion_tokens']:>7}"
              f"{('$%.4f' % u) if u else 'n/a':>10}"
              f"{('$%.3f' % (u / n * 1000)) if u else 'n/a':>9}")


if __name__ == "__main__":
    sys.exit(main())
