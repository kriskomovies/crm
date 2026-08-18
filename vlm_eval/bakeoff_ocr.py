"""Score local OCR on the same sheet and the same reference as the models.

Runs in its own interpreter (an isolated venv) because rapidocr pulls in
onnxruntime, and the point of comparing it against Tesseract is to find out
whether the extra dependency buys anything.

Both readers get the same help the agent's own device/ocr.py gives Tesseract:
the handle line cropped out on its own, upscaled 3x, Otsu-thresholded, and
restricted to the characters a Snapchat handle can contain. That is the
configuration already tuned for this font, so this measures the readers rather
than the preprocessing.

    ocrenv/Scripts/python.exe bakeoff_ocr.py --sheet ... --entries 97
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

import cv2

RESULTS = Path(__file__).resolve().parent / "results"
CELL_W, CELL_H, COLS = 345, 87, 3

# Inside a 345x87 cell: the avatar occupies the left ~72px, the display name
# sits above the handle. Measured off the crops, not assumed.
TEXT_X0 = 72
NAME_Y = (8, 46)
HANDLE_Y = (44, 80)

USER_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789._"
HANDLE_RE = re.compile(r"^[a-z][a-z0-9._-]{2,14}$")


def norm(h):
    return re.sub(r"[^a-z0-9._-]", "", (h or "").strip().lower().lstrip("@"))


def cells(img, n_entries):
    out = []
    for n in range(1, n_entries + 1):
        r, c = divmod(n - 1, COLS)
        out.append((n, img[r * CELL_H:(r + 1) * CELL_H,
                           c * CELL_W:(c + 1) * CELL_W]))
    return out


def prep(crop, scale=3):
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]


def run_tesseract(cs):
    import pytesseract
    pytesseract.pytesseract.tesseract_cmd = \
        r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    out = {}
    for n, cell in cs:
        band = cell[HANDLE_Y[0]:HANDLE_Y[1], TEXT_X0:]
        cfg = f"--psm 7 -c tessedit_char_whitelist={USER_CHARS}"
        txt = pytesseract.image_to_string(prep(band), config=cfg)
        out[n] = norm(txt.replace(" ", ""))
    return out


def run_rapidocr(cs, threshold=False):
    """RapidOCR over the same band.

    Two differences from the Tesseract path, both of them corrections to the
    harness rather than favours to the library:

    boxes are sorted left to right. RapidOCR is a detector plus a recogniser,
    so it returns several boxes per line in no particular order; concatenating
    them as they arrive turned "scottc120" into "12scottc20" and scored the
    library at 33% for a fault that was mine.

    the image is not thresholded by default. Tesseract wants a clean bilevel
    bitmap; RapidOCR's recogniser is trained on natural images and binarising
    first throws away the antialiasing it uses.
    """
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    out = {}
    for n, cell in cs:
        band = cell[HANDLE_Y[0]:HANDLE_Y[1], TEXT_X0:]
        img = prep(band) if threshold else cv2.resize(
            band, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
        res, _ = engine(img)
        parts = sorted(((min(p[0] for p in box), txt)
                        for box, txt, _ in (res or [])), key=lambda t: t[0])
        out[n] = norm("".join(t for _, t in parts).replace(" ", ""))
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--entries", type=int, required=True)
    ap.add_argument("--tag", default="live")
    a = ap.parse_args(argv)

    img = cv2.imread(a.sheet)
    if img is None:
        raise SystemExit(f"cannot read {a.sheet}")
    cs = cells(img, a.entries)

    refp = RESULTS / f"bakeoff_consensus_{a.tag}.json"
    ref = {int(k): v for k, v in
           json.loads(refp.read_text(encoding="utf-8"))["reference"].items()}
    refset = set(ref.values())
    print(f"{len(cs)} cells, reference has {len(refset)} handles\n")

    print(f"{'reader':<14}{'sec':>7}{'exact':>8}{'set':>7}{'valid':>8}"
          f"{'blank':>7}{'$/1k':>8}")
    print("-" * 60)
    results = {}
    readers = (("tesseract", run_tesseract),
               ("rapidocr", lambda c: run_rapidocr(c, threshold=False)),
               ("rapidocr+otsu", lambda c: run_rapidocr(c, threshold=True)))
    for name, fn in readers:
        t0 = time.time()
        try:
            got = fn(cs)
        except Exception as e:                  # noqa: BLE001
            print(f"{name:<14} unavailable: {str(e)[:60]}")
            continue
        secs = time.time() - t0
        exact = sum(1 for n, h in got.items() if ref.get(n) == h)
        inset = sum(1 for h in got.values() if h and h in refset)
        valid = sum(1 for h in got.values() if HANDLE_RE.match(h))
        blank = sum(1 for h in got.values() if not h)
        results[name] = got
        print(f"{name:<14}{secs:>7.1f}{exact:>8}{inset:>7}{valid:>8}"
              f"{blank:>7}{'$0.000':>8}")

    print("\nexact = same handle the model panel agreed on for that cell")
    print("set   = a real handle from the roster, even if in the wrong cell")
    print("valid = shaped like a Snapchat handle (an invalid read is at least "
          "detectable; a valid-but-wrong one is not)")

    for name, got in results.items():
        wrong = [(n, ref.get(n), h) for n, h in sorted(got.items())
                 if ref.get(n) != h]
        print(f"\n{name}: {len(wrong)} disagreements with the panel "
              f"(first 20)")
        for n, want, have in wrong[:20]:
            flag = "  <- plausible but wrong" if HANDLE_RE.match(have) else ""
            print(f"  {n:>3}  want {want:<20} got {have or '(blank)'}{flag}")

    (RESULTS / f"bakeoff_ocr_{a.tag}.json").write_text(
        json.dumps({k: {str(n): h for n, h in v.items()}
                    for k, v in results.items()}, indent=1, ensure_ascii=False),
        encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
