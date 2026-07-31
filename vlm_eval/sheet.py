"""Geometry for the 99-entry contact sheet in ../test/main/all99_3col.png.

The sheet is the whole Quick Add roster flattened into one image: 33 grid rows
of 3 columns, read left-to-right then top-to-bottom, which is exactly the order
the ground-truth roster is in. That ordering is the only reason a model's answer
can be lined up with the key without matching on the handle first.

    entry 1  entry 2  entry 3
    entry 4  entry 5  entry 6
    ...

Cells are a fixed 345x87, verified against the white gutters between rows rather
than assumed. Cropping a horizontal band of grid rows gives a smaller image with
fewer entries in it, which is the knob that decides whether a model is being
asked to read 99 lines of 13px text at once or 18.

    python sheet.py            # dump band crops for eyeballing
"""
import json
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
SHEET = HERE.parent / "test" / "main" / "all99_3col.png"
GT = HERE / "ground_truth.json"

COLS = 3
GRID_ROWS = 33
CELL_W = 345
CELL_H = 87
N_ENTRIES = 99          # the 33x3 grid is full


def load_sheet():
    img = cv2.imread(str(SHEET))
    if img is None:
        raise SystemExit(f"cannot read {SHEET}")
    h, w = img.shape[:2]
    if (w, h) != (COLS * CELL_W, GRID_ROWS * CELL_H):
        raise SystemExit(f"{SHEET.name} is {w}x{h}, expected "
                         f"{COLS * CELL_W}x{GRID_ROWS * CELL_H}")
    return img


def bands(rows_per_call):
    """(start_grid_row, n_grid_rows) tiling all 33 grid rows."""
    if rows_per_call >= GRID_ROWS:
        return [(0, GRID_ROWS)]
    return [(s, min(rows_per_call, GRID_ROWS - s))
            for s in range(0, GRID_ROWS, rows_per_call)]


def crop_band(img, start, count):
    return img[start * CELL_H:(start + count) * CELL_H, :]


def band_entries(start, count):
    """1-based entry numbers inside a band, in reading order."""
    first = start * COLS + 1
    return list(range(first, min(first + count * COLS, N_ENTRIES + 1)))


def upscale(img, factor):
    if factor == 1:
        return img
    return cv2.resize(img, None, fx=factor, fy=factor,
                      interpolation=cv2.INTER_LANCZOS4)


def roster():
    """The 99 unique entries from ground_truth.json, in sheet reading order.

    ground_truth.json is keyed by scrolling page and the pages overlap, so the
    same handle appears on two pages. First sighting wins and the scroll order
    is the sheet order -- which is checked, not assumed: 99 unique handles have
    to come out of it or the sheet and the key are not the same roster.
    """
    gt = json.loads(GT.read_text(encoding="utf-8"))
    out, seen = [], set()
    for page in sorted(gt["pages"]):
        for r in gt["pages"][page]:
            h = r["handle"]
            if h in seen:
                continue
            seen.add(h)
            out.append({"n": len(out) + 1, "display_name": r["display_name"],
                        "handle": h})
    if len(out) != N_ENTRIES:
        raise SystemExit(f"ground truth has {len(out)} unique handles, "
                         f"sheet has {N_ENTRIES} cells")
    return out


def main():
    img = load_sheet()
    out = HERE / "crops"
    out.mkdir(exist_ok=True)
    for start, count in bands(6):
        e = band_entries(start, count)
        cv2.imwrite(str(out / f"band_{e[0]:02d}-{e[-1]:02d}.png"),
                    crop_band(img, start, count))
    print(f"-> {out}")
    for r in roster()[:3]:
        print(r)


if __name__ == "__main__":
    main()
