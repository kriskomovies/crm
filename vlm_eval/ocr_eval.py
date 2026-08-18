"""Can a free local OCR engine replace the paid VLM for transcription?

Scores RapidOCR (PP-OCRv4 weights on onnxruntime -- no torch, no GPU) against the
same ground_truth.json the hosted-model benchmark in APIMART.md uses. The number
to beat is `gemini-3.6-flash`: 99/99 handles, 99/99 names, ~$0.73/1000 profiles.

ROW GEOMETRY IS DETECTED, NOT ASSUMED, and that correction is the whole reason
this file exists in its current form. rows.py hardcodes FIRST_ROW_TOP=176 for
every page, which is only true for some: ../pages is a SCROLLING capture, so the
list sits at a different sub-row offset on each one. On page_03 the name baseline
is at y~183 and the handle at y~213 -- both inside the first fixed row-slot --
so a fixed line-split put the handle in the name bucket and scored pages 03-08
as total failures. Clustering the boxes the engine actually found removes the
assumption, and costs one OCR call per page instead of fourteen.

Two views are reported because they answer different questions:

  glyphs  can the engine read this text at all? Roster set-membership, ignoring
          which row a string came from. This is the ceiling.
  pairs   did it also attach the right handle to the right display name? That is
          what the pipeline consumes, and it is the number that decides this.

    D:\\ocr-venv\\Scripts\\python.exe ocr_eval.py
"""
import io
import json
import re
import sys
import time
import unicodedata
from pathlib import Path

import cv2

# The engine can emit CJK on a misread and the Windows console is cp1252.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
PAGES = HERE.parent / "pages"
GT = HERE / "ground_truth.json"

# The name/handle column. The avatar sits left of x=100 and the "+1 Add" button
# right of x=600, so this window is the text and nothing else.
COL_X = (100, 600)
HEADER_Y = 160          # below "Quick Add" / "All Contacts"
ROW_GAP = 50            # two lines of one row are ~30px apart; rows are ~100
CHROME = re.compile(r"^(find friends|quick add|all contacts|\+?\d*\s*add|[\d:]+)\s*>?$", re.I)


def is_emoji(c):
    o = ord(c)
    return (unicodedata.category(c) == "So"
            or 0x1F000 <= o <= 0x1FAFF
            or 0x1F3FB <= o <= 0x1F3FF
            or o in (0x200D, 0xFE0F, 0x20E3))


def strip_emoji(s):
    """score.py's headline display_name metric. OCR cannot emit emoji at all, so
    scoring raw names would only re-measure a known limitation."""
    s = unicodedata.normalize("NFKC", str(s or ""))
    return " ".join("".join(c for c in s if not is_emoji(c)).split())


def norm(s):
    return " ".join(unicodedata.normalize("NFKC", str(s or "")).strip().casefold().split())


def levenshtein(a, b):
    if a == b:
        return 0
    if not a or not b:
        return len(a) or len(b)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# ------------------------------------------------------------------- read -----
def page_rows(engine, path):
    """[(display_name, handle)] for one page, rows found by clustering boxes."""
    result, _ = engine(cv2.imread(str(path)))
    boxes = []
    for box, text, _score in result or []:
        xs, ys = [p[0] for p in box], [p[1] for p in box]
        yc = sum(ys) / len(ys)
        if yc < HEADER_Y or not (COL_X[0] <= min(xs) <= COL_X[1]):
            continue
        if CHROME.match(text.strip()):
            continue
        boxes.append((yc, min(xs), text.strip()))

    rows, cur = [], []
    for b in sorted(boxes):
        if cur and b[0] - cur[-1][0] > ROW_GAP:
            rows.append(cur)
            cur = []
        cur.append(b)
    if cur:
        rows.append(cur)

    out = []
    for row in rows:
        # Two lines: the display name sits above its handle. Fragments of one
        # line (a first and last name split into two boxes) share a baseline.
        lines = []
        for b in row:
            if lines and b[0] - lines[-1][-1][0] <= 12:
                lines[-1].append(b)
            else:
                lines.append([b])
        joined = [" ".join(t for _, _, t in sorted(ln, key=lambda b: b[1])) for ln in lines]
        if len(joined) >= 2:
            out.append((joined[0], joined[-1].replace(" ", "")))
        elif joined:
            # One line only: classify it. Handles are lowercase, spaceless, and
            # usually carry a digit, dot or underscore.
            s = joined[0]
            looks_handle = " " not in s and s == s.lower() and re.search(r"[\d._]", s)
            out.append(("", s) if looks_handle else (s, ""))
    return out


# ------------------------------------------------------------------ score -----
def roster():
    """99 unique entries in scroll order; first sighting wins (pages overlap)."""
    gt = json.loads(GT.read_text(encoding="utf-8"))["pages"]
    out, seen = [], set()
    for page in sorted(gt):
        for r in gt[page]:
            if r["handle"] in seen:
                continue
            seen.add(r["handle"])
            out.append(r)
    return out


def main():
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    print("running OCR: 1 call per page over 9 pages")
    t0 = time.time()
    pages = {}
    for path in sorted(PAGES.glob("page_*.png")):
        pages[path.stem] = page_rows(engine, path)
        print(f"  {path.stem}: {len(pages[path.stem])} rows found")
    secs = time.time() - t0

    people = roster()
    pairs = [p for rows in pages.values() for p in rows]
    seen_text = {norm(t) for p in pairs for t in p if t}
    pair_index = {norm(h): norm(n) for n, h in pairs if h}

    glyph_h = sum(norm(r["handle"]) in seen_text for r in people)
    glyph_n = sum(norm(strip_emoji(r["display_name"])) in seen_text for r in people)
    paired = sum(
        norm(r["handle"]) in pair_index
        and pair_index[norm(r["handle"])] == norm(strip_emoji(r["display_name"]))
        for r in people
    )

    # CER over handles, best reading per roster entry.
    total_d = total_l = 0
    misses = []
    for r in people:
        key = norm(r["handle"])
        best = min((levenshtein(key, norm(h)) for _, h in pairs if h), default=len(key))
        total_d += best
        total_l += len(key)
        if best:
            got = min(((levenshtein(key, norm(h)), h) for _, h in pairs if h), default=(0, ""))[1]
            misses.append((r["handle"], got, best))

    known = {norm(r["handle"]) for r in people}
    invented = [h for _, h in pairs if h and norm(h) not in known]

    print(f"\n{'':<30}{'RapidOCR (local)':>18}{'gemini-3.6-flash':>20}")
    print("-" * 68)
    print(f"{'handles read (glyph ceiling)':<30}{f'{glyph_h}/99':>18}{'99/99':>20}")
    print(f"{'names read, emoji-stripped':<30}{f'{glyph_n}/99':>18}{'99/99':>20}")
    print(f"{'name+handle correctly PAIRED':<30}{f'{paired}/99':>18}{'99/99':>20}")
    print(f"{'handle CER':<30}{f'{total_d / max(1, total_l):.2%}':>18}{'~0%':>20}")
    print(f"{'emoji captured':<30}{'0 (cannot)':>18}{'96/99':>20}")
    print(f"{'rows detected':<30}{f'{len(pairs)}':>18}{'126 slots':>20}")
    print(f"{'unrecognised handle strings':<30}{f'{len(invented)}':>18}{'0':>20}")
    print(f"{'wall clock, all 99':<30}{f'{secs:.1f}s':>18}{'44-76s':>20}")
    print(f"{'$ / 1000 profiles':<30}{'0.00':>18}{'0.72-0.75':>20}")

    print(f"\n{len(misses)} handles never read exactly:")
    for key, got, d in misses:
        print(f"  key {key!r:<24} best ocr {got!r:<24} dist {d}")

    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "ocr_eval.json").write_text(json.dumps({
        "seconds": secs, "pages": pages, "misses": misses, "invented": invented,
    }, indent=1), encoding="utf-8")
    print("\nwrote results/ocr_eval.json")


if __name__ == "__main__":
    main()
