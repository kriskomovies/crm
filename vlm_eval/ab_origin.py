"""Does letting the avatar inform nationality cost us anglophone targets?

The targeting bucket is anglophone-or-not: American, British, Canadian,
Australian, Scottish, Welsh and Irish all route as "English", while Greek,
Indian, Italian and Spanish must not fall back into it. So the only thing the
nationality field decides is whether a person enters the queue at all.

The proposal was to judge it from the drawn avatar as well as the name. The
worry is specific and testable: the loudest visual signal a Bitmoji carries is
skin tone, so a brown cartoon on an anglophone name has an obvious route out of
the English bucket, and the person is dropped for how their cartoon looks.

Two arms, identical but for the nationality rule, over the same sheet and the
same models:

    A  the live production prompt, nationality from the NAME
    B  the same prompt, nationality from the name AND the avatar

Arm B is written the way someone who wanted this would write it, not as a
strawman -- same structure, same vocabulary, same refusal to split American
from British, with the appearance added. What is counted is DEFECTIONS: entries
anglophone under A and not under B. Each one is a target the change would lose,
and each is printed with the skin tone the same reply reported, because if the
defectors are the tanned ones then the mechanism is not in doubt.

Both models are run because a single model changing its mind is a quirk; both
models changing it the same way is the prompt.
"""
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

SHEET = r"C:\Users\Krisko\AppData\Local\Temp\wide_sheet.png"
ENTRIES, COLS = 33, 2
MODELS = ["gemini-3-flash-preview-nothinking", "gemini-3.6-flash"]
RESULTS = Path(__file__).resolve().parent / "results"

# Everything that routes as "English" for this client.
ANGLO = {"english", "scottish", "welsh", "irish", "british", "american",
         "canadian", "australian", "anglophone"}

NAME_ONLY = (
    '- nationality: the origin the NAME suggests -- a guess about the name\'s '
    'linguistic origin, not a claim about the person.')
NAME_PLUS_AVATAR = (
    '- nationality: the origin the entry suggests, judging the NAME and the '
    'DRAWN AVATAR together -- the name\'s linguistic origin alongside what the '
    'cartoon\'s appearance suggests. This is a reading of a name and a drawing, '
    'not a claim about the person.')


def arm_b(text):
    if NAME_ONLY not in text:
        raise RuntimeError("production nationality rule not found; it changed")
    return text.replace(NAME_ONLY, NAME_PLUS_AVATAR)


def ask(model_id, uri, prompt, key, tag):
    before = None
    try:
        before = pricing.balance_units()
    except Exception:                               # noqa: BLE001
        pass
    t0 = time.time()
    try:
        txt, meta = apimart.Model(model_id, key=key).ask(prompt, [uri])
    except Exception as e:                          # noqa: BLE001
        print(f"  {model_id:<38} {tag}  ERROR {str(e)[:50]}")
        return None
    secs = round(time.time() - t0, 1)
    time.sleep(2)
    usd = None
    try:
        if before is not None:
            usd = (pricing.balance_units() - before) / pricing.UNITS_PER_USD
    except Exception:                               # noqa: BLE001
        pass
    got = sheet_task.entries_from(sheet_task.extract_json(txt))
    for i, e in enumerate(got):
        try:
            e["n"] = int(e.get("n"))
        except (TypeError, ValueError):
            e["n"] = i + 1
    out = {"model": model_id, "arm": tag, "seconds": secs,
           "prompt_tokens": meta.get("prompt_tokens"),
           "completion_tokens": meta.get("completion_tokens"),
           "measured_usd": usd, "entries": got}
    RESULTS.mkdir(exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", model_id)
    (RESULTS / f"ab_{slug}_{tag}.json").write_text(
        json.dumps(out | {"raw": txt}, indent=1, ensure_ascii=False),
        encoding="utf-8")
    print(f"  {model_id:<38} {tag}  {secs:>5.1f}s  {len(got):>2}/{ENTRIES}"
          f"  {('$%.5f' % usd) if usd else 'n/a':>9}")
    return out


def norm(s):
    return (s or "").strip().lower()


def main():
    img = cv2.imread(SHEET)
    if img is None:
        raise SystemExit(f"cannot read {SHEET}")
    uri = apimart.png_data_uri(img)
    key = apimart.api_key()
    a_text = prod_prompt.sheet_prompt(ENTRIES, COLS)
    b_text = arm_b(a_text)
    print(f"{SHEET}  {img.shape[1]}x{img.shape[0]}  {ENTRIES} entries\n"
          f"arm A = production prompt, arm B = +avatar "
          f"({len(b_text) - len(a_text):+d} chars)\n")

    runs = {}
    for mid in MODELS:
        for tag, text in (("A", a_text), ("B", b_text)):
            r = ask(mid, uri, text, key, tag)
            if r:
                runs[(mid, tag)] = r

    for mid in MODELS:
        ra, rb = runs.get((mid, "A")), runs.get((mid, "B"))
        if not ra or not rb:
            continue
        ea = {e["n"]: e for e in ra["entries"]}
        eb = {e["n"]: e for e in rb["entries"]}
        print(f"\n{'=' * 78}\n{mid}\n{'=' * 78}")
        print(f"{'':>3} {'name':<22}{'A (name)':<14}{'B (+avatar)':<14}"
              f"{'tone':<12}")
        print("-" * 68)
        defect, gain, anglo_a, anglo_b = [], [], 0, 0
        for n in range(1, ENTRIES + 1):
            x, y = ea.get(n, {}), eb.get(n, {})
            va, vb = norm(x.get("nationality")), norm(y.get("nationality"))
            ia, ib = va in ANGLO, vb in ANGLO
            anglo_a += ia
            anglo_b += ib
            tone = norm(y.get("skin_tone")) or norm(x.get("skin_tone"))
            mark = ""
            if ia and not ib:
                defect.append((n, x.get("display_name"), va, vb, tone))
                mark = "  <- LOST"
            elif ib and not ia:
                gain.append((n, x.get("display_name"), va, vb))
                mark = "  <- gained"
            print(f"{n:>3} {(x.get('display_name') or '')[:21]:<22}"
                  f"{va[:13]:<14}{vb[:13]:<14}{tone[:11]:<12}{mark}")
        print(f"\n  in the English bucket:  A {anglo_a}/{ENTRIES}   "
              f"B {anglo_b}/{ENTRIES}")
        print(f"  targets LOST by adding the avatar: {len(defect)}")
        for n, nm, va, vb, tone in defect:
            print(f"    #{n:<3} {(nm or '')[:20]:<22}{va} -> {vb}"
                  f"   (avatar tone: {tone})")
        if gain:
            print(f"  gained: {len(gain)}")
            for n, nm, va, vb in gain:
                print(f"    #{n:<3} {(nm or '')[:20]:<22}{va} -> {vb}")

    print(f"\n{'model':<40}{'arm':>5}{'sec':>7}{'in':>7}{'out':>7}"
          f"{'$/sheet':>10}{'$/1000':>9}")
    print("-" * 85)
    for (mid, tag), r in runs.items():
        usd = r["measured_usd"]
        print(f"{mid:<40}{tag:>5}{r['seconds']:>7.1f}{r['prompt_tokens']:>7}"
              f"{r['completion_tokens']:>7}"
              f"{('$%.5f' % usd) if usd else 'n/a':>10}"
              f"{('$%.3f' % (usd / ENTRIES * 1000)) if usd else 'n/a':>9}")


if __name__ == "__main__":
    sys.exit(main())
