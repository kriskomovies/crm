"""Run models over a LIVE 900x1600 Quick Add capture and put them side by side.

    python live_page_eval.py <page.png> gemini-3.6-flash gemini-3-flash-preview-nothinking

There is NO KEY for a fresh capture, and that is the whole point of keeping this
separate from score_sheet.py. What it produces is a comparison, not a score: the
same page read by N models, printed next to each other so a human can look at the
image and adjudicate. Anything else would be inventing ground truth.

Why bother when ground_truth.json exists: the keyed corpus is one roster captured
once. A live page is the data the pipeline actually meets today, and it carries a
much denser facial-hair sample than the 21-in-99 the old sheet has -- which is
the field both models are currently worst at.
"""
import json
import sys
from pathlib import Path

import apimart

HERE = Path(__file__).resolve().parent

PROMPT = """\
This image is one screen of a Snapchat "Quick Add" friend-suggestion list, a \
single vertical column of entries.

Each entry is a round cartoon avatar on the left, a display name in black to its \
right, and a grey username handle directly under the name.

Read every entry that is FULLY visible, top to bottom. Skip an entry that is cut \
off by the top or bottom edge of the screen.

Return ONLY a JSON object, no prose and no markdown fence:
{"entries": [{"n": 1, "display_name": "...", "handle": "...", \
"nationality": "...", "avatar_presents_as": "...", "facial_hair": "...", \
"bald": "..."}, ...]}

Rules:
- display_name: copy the black text EXACTLY, including emoji and accents.
- handle: the grey text under the name, exactly as rendered.
- nationality: the origin the NAME reads as, one adjective. Use "English" for \
any name that simply reads as a generic English-language name -- do NOT split \
those into American, British, Canadian or Australian. Use "unknown" when the \
entry is only initials or digits.
- avatar_presents_as: judge ONLY the cartoon: "man", "woman", "ambiguous", or \
"not-a-person" for a blank silhouette with no face.
- facial_hair: exactly one of "none", "stubble", "moustache", "goatee", \
"beard", "beard+moustache", "moustache+goatee". Answer "none" explicitly for a \
clean-shaven face; never leave it blank.
- bald: "yes", "no", or "unknown" when a hat or hood hides the top of the head.
"""


def main(argv):
    if not argv:
        print(__doc__)
        return
    img_path = Path(argv[0])
    models = argv[1:] or ["gemini-3.6-flash"]
    uri = apimart.png_data_uri(__import__("cv2").imread(str(img_path)))

    runs = {}
    for m in models:
        print(f"asking {m} ...", flush=True)
        try:
            txt, meta = apimart.Model(m).ask(PROMPT, [uri])
            import sheet_task
            got = sheet_task.entries_from(sheet_task.extract_json(txt))
            runs[m] = {"entries": got, "meta": meta}
            print(f"  {len(got)} entries, in={meta.get('prompt_tokens')} "
                  f"out={meta.get('completion_tokens')} {meta.get('seconds')}s")
        except Exception as e:                  # noqa: BLE001 - a dead model is a result
            print(f"  FAILED: {str(e)[:160]}")
            runs[m] = {"entries": [], "meta": {}}

    # Aligned on handle: the models agree on those far more than on order, and a
    # positional join would silently pair different people if one skipped a row.
    order, seen = [], set()
    for m in models:
        for e in runs[m]["entries"]:
            h = (e.get("handle") or "").strip().lower()
            if h and h not in seen:
                seen.add(h)
                order.append(h)

    out = HERE / "results" / f"live_{img_path.stem}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(runs, indent=1, ensure_ascii=False), encoding="utf-8")

    for field in ("facial_hair", "nationality", "avatar_presents_as", "bald"):
        print(f"\n=== {field} ===")
        print(f"{'handle':<20}" + "".join(f"{m[:26]:<28}" for m in models))
        print("-" * (20 + 28 * len(models)))
        for h in order:
            cells = []
            for m in models:
                e = next((x for x in runs[m]["entries"]
                          if (x.get("handle") or "").strip().lower() == h), None)
                cells.append(str((e or {}).get(field, "-") or "(blank)")[:26])
            agree = len(set(cells)) == 1
            print(f"{h:<20}" + "".join(f"{c:<28}" for c in cells)
                  + ("" if agree else "  <-- differ"))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
