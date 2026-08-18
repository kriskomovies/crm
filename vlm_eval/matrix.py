"""Two models over one sheet, printed side by side for eyeball comparison.

Answers a different question from score_sheet.py. There is no key for a freshly
captured roster, and for the judgement fields there can never be one: whether a
drawn avatar reads as having a beard is a reading, not a fact. So nothing here
is scored as right or wrong. The models are put in adjacent columns, in sheet
order, and where they disagree the row is marked -- agreement is evidence, a
disagreement is a thing to look at.

Cost is MEASURED, not looked up. The gateway stopped publishing per-token
prices, so the only honest number is the change in its own spend counter around
an isolated call. That forces the runs to be sequential and one at a time; with
two models in flight the diff would be their sum.

    python matrix.py --sheet C:/path/sheet.png --entries 33 \
        --models gemini-2.5-flash-lite gemini-3-flash-preview-nothinking
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

import cv2

import apimart
import pricing
import prod_prompt
import sheet_task

RESULTS = Path(__file__).resolve().parent / "results"

PROMPT = """\
This image is a contact sheet of {n} entries from a Snapchat friend-suggestion \
list, laid out as a grid {cols} columns wide.

READING ORDER IS CRITICAL: go left to right across each row of the grid, then \
down to the next row. Entry 1 is top-left, entry 2 is top-right, entry 3 is the \
left of the second row, and so on. Number them 1 to {n} in that order.

Each entry is a round cartoon avatar (a Bitmoji), a display name in black, and \
a grey username handle directly under the name.

Return ONLY a JSON object, no prose and no markdown fence:
{{"entries": [{{"n": 1, "display_name": "...", "handle": "...", \
"presents_as": "...", "origin": "...", "origin_evidence": "...", \
"skin_tone": "...", "facial_hair": "..."}}, ...]}}

Emit exactly {n} entries, numbered 1 to {n}, none skipped.

Rules:
- display_name: copy the black text EXACTLY as rendered, character for \
character, including every emoji in order. Do not correct spelling.
- handle: the grey lowercase text directly under the name. Copy it exactly, \
including dots, underscores, hyphens and digits.
- presents_as: judge ONLY the drawn cartoon, ignoring the name completely. One \
of "man", "woman", "ambiguous", "not-a-person". Look at hair length, eye \
makeup, lipstick, earrings, jewellery, facial hair and clothing. \
"not-a-person" if the avatar is a blank silhouette or not a human figure. A \
feminine cartoon is "woman" even when the name reads male.
- origin: the nationality the NAME AND HANDLE most suggest. This is a guess \
about a name's origin, not a claim about the person. One of "English", \
"Scottish", "Welsh", "Irish", "American", "Australian", "Canadian", \
"Italian", "Spanish", "French", "German", "Greek", "Turkish", "Arabic", \
"Indian", "other", "unknown".
  Separate British from American ONLY on real evidence: a national flag emoji \
in the display name, a Mc-/Mac- or distinctly Scottish, Welsh or Irish \
surname, a British place name, or British spelling or slang. A generic \
anglophone first name with a number after it does not distinguish Manchester \
from Milwaukee -- for those answer "unknown". Do NOT default to "American", \
and do not treat the absence of a flag as evidence of anything.
- origin_evidence: in a few words, the specific thing in THIS entry that \
decided the origin, e.g. "UK flag emoji", "Mc- surname", "Welsh first name", \
"first name and digits only".
- skin_tone: the face colour of the drawn avatar. One of "pale", "light", \
"light-tan", "medium-tan", "tan", "brown", "dark-brown", or "placeholder" for \
a blank coloured silhouette with no face, "stylised" for a non-realistic face \
colour, "unreadable" if the face cannot be seen. This describes a cartoon \
setting the account chose, not a person.
- facial_hair: what the drawn avatar has on its face. One of "none", \
"moustache", "beard", "both", or "unclear". "beard" covers stubble and goatee. \
Use "both" only when a moustache is drawn distinctly from the beard. Use \
"unclear" for silhouettes and avatars whose face is hidden."""


def norm(s):
    return (s or "").strip().lower()


def run(model_id, uri, n, cols, key, tag="", prompt=None):
    """One isolated call, with the gateway's spend counter read either side."""
    before = None
    try:
        before = pricing.balance_units()
    except Exception:                           # noqa: BLE001
        pass
    m = apimart.Model(model_id, key=key)
    t0 = time.time()
    try:
        txt, meta = m.ask(prompt or PROMPT.format(n=n, cols=cols), [uri])
    except Exception as e:                      # noqa: BLE001
        print(f"  {model_id:<38} ERROR {str(e)[:60]}")
        return None
    secs = round(time.time() - t0, 1)
    time.sleep(2)                               # let the counter settle
    spend = None
    try:
        if before is not None:
            spend = (pricing.balance_units() - before) / pricing.UNITS_PER_USD
    except Exception:                           # noqa: BLE001
        pass
    got = sheet_task.entries_from(sheet_task.extract_json(txt))
    for i, e in enumerate(got):
        try:
            e["n"] = int(e.get("n"))
        except (TypeError, ValueError):
            e["n"] = i + 1
    out = {"model": model_id, "seconds": secs, "parsed": len(got),
           "prompt_tokens": meta.get("prompt_tokens"),
           "completion_tokens": meta.get("completion_tokens"),
           "measured_usd": spend, "entries": got, "raw": txt}
    RESULTS.mkdir(exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", model_id)
    (RESULTS / f"matrix_{slug}{'_' + tag if tag else ''}.json").write_text(
        json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"  {model_id:<38} {secs:>6.1f}s  {len(got):>3}/{n}  "
          f"in={out['prompt_tokens']} out={out['completion_tokens']}  "
          f"${spend:.5f}" if spend else
          f"  {model_id:<38} {secs:>6.1f}s  {len(got):>3}/{n}")
    return out


FIELDS = [("presents_as", "presents"), ("origin", "origin"),
          ("skin_tone", "skin tone"), ("facial_hair", "facial hair")]


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--entries", type=int, required=True)
    ap.add_argument("--cols", type=int, default=2)
    ap.add_argument("--models", nargs=2, required=True)
    ap.add_argument("--tag", default="")
    # "prod" reads the live server prompt instead of the experimental one above,
    # which is the only version of this test that can answer "is it safe to
    # switch the model we actually ship".
    ap.add_argument("--prompt", choices=["experimental", "prod"],
                    default="experimental")
    a = ap.parse_args(argv)

    img = cv2.imread(a.sheet)
    if img is None:
        raise SystemExit(f"cannot read {a.sheet}")
    print(f"{a.sheet}  {img.shape[1]}x{img.shape[0]}  "
          f"{a.entries} entries, {a.cols} cols\n")
    uri = apimart.png_data_uri(img)
    key = apimart.api_key()

    fields, text = FIELDS, None
    if a.prompt == "prod":
        fields = prod_prompt.FIELDS
        text = prod_prompt.sheet_prompt(a.entries, a.cols)
        print(f"prompt: production, {len(text)} chars from "
              f"{prod_prompt.TS.name}\n")

    runs = []
    for mid in a.models:                        # sequential: see the docstring
        r = run(mid, uri, a.entries, a.cols, key, a.tag, text)
        if r:
            runs.append(r)
    if len(runs) != 2:
        raise SystemExit("both models must answer to build a matrix")
    A, B = runs
    ea = {e["n"]: e for e in A["entries"]}
    eb = {e["n"]: e for e in B["entries"]}

    print(f"\n{'':>3} {'name (model A)':<24}{'handle (A)':<19}"
          f"{'handle (B)':<19}")
    print("-" * 68)
    hmis = 0
    for n in range(1, a.entries + 1):
        x, y = ea.get(n, {}), eb.get(n, {})
        ha, hb = norm(x.get("handle")), norm(y.get("handle"))
        same = ha == hb
        hmis += not same
        print(f"{n:>3} {(x.get('display_name') or '')[:23]:<24}"
              f"{ha[:18]:<19}{(hb[:18] if not same else ''):<19}"
              f"{'' if same else '  <- differs'}")
    print(f"\nhandles: {a.entries - hmis}/{a.entries} identical")

    for fld, label in fields:
        agree = 0
        print(f"\n{label}: {a.models[0]}  vs  {a.models[1]}")
        print(f"{'':>3} {'name':<24}{'A':<16}{'B':<16}")
        print("-" * 60)
        for n in range(1, a.entries + 1):
            x, y = ea.get(n, {}), eb.get(n, {})
            va, vb = norm(x.get(fld)), norm(y.get(fld))
            agree += va == vb
            mark = "" if va == vb else "  <-"
            print(f"{n:>3} {(x.get('display_name') or '')[:23]:<24}"
                  f"{va[:15]:<16}{vb[:15]:<16}{mark}")
        print(f"  agree {agree}/{a.entries} ({agree / a.entries:.0%})")

    print(f"\n{'model':<40}{'sec':>7}{'in':>8}{'out':>8}"
          f"{'$/sheet':>10}{'$/1000':>10}")
    print("-" * 84)
    for r in runs:
        usd = r["measured_usd"]
        if usd is None:
            usd = pricing.cost(r["model"], r["prompt_tokens"],
                               r["completion_tokens"])
        per1k = usd / a.entries * 1000 if usd else None
        print(f"{r['model']:<40}{r['seconds']:>7.1f}"
              f"{r['prompt_tokens']:>8}{r['completion_tokens']:>8}"
              f"{('$%.5f' % usd) if usd else 'n/a':>10}"
              f"{('$%.3f' % per1k) if per1k else 'n/a':>10}")
    print("\n$/sheet is measured from the gateway's own spend counter around "
          "each isolated call.")


if __name__ == "__main__":
    main(sys.argv[1:])
