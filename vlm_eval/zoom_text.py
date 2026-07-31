"""Upscale a row's display-name / handle strip to check exact spelling and emoji.

    python zoom_text.py page_00 7 8
"""
import sys
from pathlib import Path

import cv2

import rows

OUT = Path(__file__).resolve().parent / "crops"


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    name, idxs = argv[0], [int(a) for a in argv[1:]]
    page = rows.load_page(name)
    OUT.mkdir(exist_ok=True)
    for i in idxs:
        _, y0, _, _ = rows.row_box(i)
        strip = page[y0 + 10:y0 + 90, 110:620]
        big = cv2.resize(strip, None, fx=4, fy=4, interpolation=cv2.INTER_LANCZOS4)
        path = OUT / f"text_{name}_row{i:02d}.png"
        cv2.imwrite(str(path), big)
        print(path.name)


if __name__ == "__main__":
    main(sys.argv[1:])
