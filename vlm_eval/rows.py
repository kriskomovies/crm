"""Row geometry for the Quick Add screenshots in ../pages.

The list is a fixed-pitch table: the first row starts at y=176 and every row is
exactly 100px tall on the 900x1600 capture, so 14 rows fit before the bottom
edge clips the 15th. That means we can crop a single row without asking
uiautomator for bounds -- which matters here, because uiautomator refuses to
expose the name/@handle text at all (see ../read_usernames.py).

Cropping matters for the eval: a 7B vision model asked to read 14 rows of 20px
UI text out of one 900x1600 image does far worse than the same model asked to
read one row out of a 660x100 strip. We test both so the difference is visible
rather than assumed.

    python rows.py                  # dump per-row crops of every page to crops/
    python rows.py page_00          # just one page
"""
import sys
from pathlib import Path

import cv2

PAGES = Path(__file__).resolve().parent.parent / "pages"

FIRST_ROW_TOP = 176   # first pixel row below the "Quick Add" header
ROW_PITCH = 100       # every row is exactly this tall
ROWS_PER_PAGE = 14    # rows fully on-screen; the 15th is clipped by the bottom edge

# Two horizontal windows. "full" keeps the avatar, which you need for attribute
# questions. "text" keeps only the name/@handle column -- no avatar, no Add
# button, no X -- which is all that matters for transcription and is a third of
# the pixels, so it costs a third of the image tokens.
CROP_X = {"full": (20, 680), "text": (105, 690)}


def row_box(i, crop="full"):
    """Pixel box (x0, y0, x1, y1) of the i-th (0-based) fully-visible row."""
    x0, x1 = CROP_X[crop]
    y0 = FIRST_ROW_TOP + i * ROW_PITCH
    return x0, y0, x1, y0 + ROW_PITCH


def band_box(start, count, crop="full"):
    """Box covering `count` consecutive rows starting at row `start`.

    A band is the middle ground between one call per row and one call per
    screenshot: it keeps the cropping benefit while amortising the per-call
    overhead over several rows."""
    x0, x1 = CROP_X[crop]
    count = min(count, ROWS_PER_PAGE - start)
    y0 = FIRST_ROW_TOP + start * ROW_PITCH
    return x0, y0, x1, y0 + count * ROW_PITCH


def crop_row(page, i, crop="full"):
    """Crop one row out of an already-loaded page image."""
    x0, y0, x1, y1 = row_box(i, crop)
    return page[y0:y1, x0:x1]


def crop_band(page, start, count, crop="full"):
    x0, y0, x1, y1 = band_box(start, count, crop)
    return page[y0:y1, x0:x1]


def bands(n_per_call):
    """(start, count) pairs tiling all 14 rows in groups of n_per_call."""
    return [(s, min(n_per_call, ROWS_PER_PAGE - s))
            for s in range(0, ROWS_PER_PAGE, n_per_call)]


def load_page(name):
    """Load pages/<name>.png, erroring loudly if the geometry is not what we assume."""
    path = PAGES / f"{name}.png"
    img = cv2.imread(str(path))
    if img is None:
        raise SystemExit(f"cannot read {path}")
    h, w = img.shape[:2]
    if (w, h) != (900, 1600):
        raise SystemExit(f"{path.name} is {w}x{h}, but the row geometry assumes 900x1600")
    return img


def page_names():
    return sorted(p.stem for p in PAGES.glob("page_*.png"))


def main(argv):
    names = argv or page_names()
    out = Path(__file__).resolve().parent / "crops"
    out.mkdir(exist_ok=True)
    for name in names:
        page = load_page(name)
        for i in range(ROWS_PER_PAGE):
            cv2.imwrite(str(out / f"{name}_row{i:02d}.png"), crop_row(page, i))
        print(f"{name}: wrote {ROWS_PER_PAGE} crops")
    print(f"\n-> {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
