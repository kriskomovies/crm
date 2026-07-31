"""Stack every row of a page into one tall upscaled image, so all 14 names (or
all 14 avatars) can be checked in a single look instead of 14 separate ones.

    python montage.py page_00 text      # name + handle strips
    python montage.py page_00 face      # avatar circles
"""
import sys
from pathlib import Path

import cv2
import numpy as np

import rows

OUT = Path(__file__).resolve().parent / "crops"

REGIONS = {
    "text": (110, 620, 8, 92, 3),    # x0, x1, dy0, dy1, scale
    "face": (20, 125, 0, 100, 4),
}


def main(argv):
    name = argv[0] if argv else "page_00"
    kind = argv[1] if len(argv) > 1 else "text"
    if kind not in REGIONS:
        raise SystemExit(f"kind must be one of {list(REGIONS)}")
    x0, x1, dy0, dy1, scale = REGIONS[kind]

    page = rows.load_page(name)
    strips = []
    for i in range(rows.ROWS_PER_PAGE):
        _, y0, _, _ = rows.row_box(i)
        s = page[y0 + dy0:y0 + dy1, x0:x1]
        s = cv2.resize(s, None, fx=scale, fy=scale, interpolation=cv2.INTER_LANCZOS4)
        # a black rule between strips so rows cannot be visually conflated
        strips.append(s)
        strips.append(np.zeros((3, s.shape[1], 3), dtype=np.uint8))

    OUT.mkdir(exist_ok=True)
    path = OUT / f"montage_{name}_{kind}.png"
    cv2.imwrite(str(path), np.vstack(strips))
    print(path)


if __name__ == "__main__":
    main(sys.argv[1:])
