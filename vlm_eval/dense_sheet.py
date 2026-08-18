"""Build a tighter contact sheet: less dead space, fewer entries, bigger avatars.

    python dense_sheet.py --entries 50 --cols 2
    python dense_sheet.py --entries 50 --cols 2 --width 260   # crop harder

WHY THIS MIGHT HELP, AND WHY IT MIGHT NOT
-----------------------------------------
A vision model resizes every image into a roughly fixed tile budget -- measured
on this gateway, a third of the sheet costs 1088 image tokens against 1100 for
the whole thing. So shrinking the image saves nothing. What matters is each
avatar's SHARE of that fixed budget.

On the 99-entry sheet an avatar is 74x82 inside 2.97 Mpx: about 0.20% of the
image, which works out near 3.5 visual tokens. That is why facial_hair collapses
there (2/21 for the nothinking model) and works on a native page with 13 entries
(5/6). Fewer entries per image is the lever; cropping the dead margin is a
second, smaller one.

The cost is more calls. For a THINKING model that is expensive, because it
re-reasons per call. For a nothinking model output is small and input is cheap,
so the penalty is much lower -- which is exactly why this is worth measuring
rather than assuming.

WHAT IT DOES NOT DO
-------------------
It does not make the avatar bigger in pixels. 74x82 is what the capture gave us
and upscaling was already measured as useless (ROUTING.md: 3x upscale changed
nothing). This only changes how much of the model's attention each face gets.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

import sheet

HERE = Path(__file__).resolve().parent
OUT = HERE / "results"


def ink_width(cell, thresh=235):
    """Rightmost non-background column, so a crop keeps every glyph."""
    g = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
    cols = np.nonzero((g < thresh).any(axis=0))[0]
    return int(cols.max()) + 1 if len(cols) else sheet.CELL_W


def build(entries=50, cols=2, width=None, start=0, pad=4):
    """-> (image, [entry numbers], truncated_count)

    `width` None means "wide enough for every entry included", which is the safe
    default: cropping to a percentile would silently cut the tail off long
    display names, and a truncated name is a scored field turned into noise.
    """
    img = sheet.load_sheet()
    picked = list(range(start + 1, min(start + entries, sheet.N_ENTRIES) + 1))

    cells, needed = [], []
    for n in picked:
        i = n - 1
        r, c = divmod(i, sheet.COLS)
        cell = img[r * sheet.CELL_H:(r + 1) * sheet.CELL_H,
                   c * sheet.CELL_W:(c + 1) * sheet.CELL_W]
        cells.append(cell)
        needed.append(ink_width(cell))

    w = width or (max(needed) + pad)
    truncated = sum(1 for n in needed if n > w)

    tiles = [c[:, :min(w, c.shape[1])] for c in cells]
    th = sheet.CELL_H
    rows = []
    for s in range(0, len(tiles), cols):
        chunk = tiles[s:s + cols]
        while len(chunk) < cols:
            chunk.append(np.full((th, w, 3), 255, np.uint8))
        rows.append(np.hstack(chunk))
    return np.vstack(rows), picked, truncated


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--entries", type=int, default=50)
    ap.add_argument("--cols", type=int, default=2)
    ap.add_argument("--width", type=int, default=None)
    ap.add_argument("--start", type=int, default=0)
    a = ap.parse_args()

    im, picked, trunc = build(a.entries, a.cols, a.width, a.start)
    OUT.mkdir(exist_ok=True)
    p = OUT / f"dense_{len(picked)}e_{a.cols}c{'_w' + str(a.width) if a.width else ''}.png"
    cv2.imwrite(str(p), im)

    mpx = im.shape[0] * im.shape[1] / 1e6
    av = 74 * 82
    share = 100 * av / (im.shape[0] * im.shape[1])
    base = 100 * av / (sheet.COLS * sheet.CELL_W * sheet.GRID_ROWS * sheet.CELL_H)
    print(f"{p.name}: {im.shape[1]}x{im.shape[0]} = {mpx:.2f} Mpx, "
          f"{len(picked)} entries ({picked[0]}-{picked[-1]})")
    if trunc:
        print(f"  WARNING: {trunc} entries have ink past the crop width -- "
              f"their display names are cut")
    print(f"  avatar share of image: {share:.2f}%  "
          f"(99-entry sheet: {base:.2f}%)  -> {share / base:.1f}x")
    print(f"\nwrote {p}")


if __name__ == "__main__":
    main()
