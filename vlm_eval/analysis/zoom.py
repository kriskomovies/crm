"""Upscale a row's avatar so small Bitmoji details (facial hair, skin tone) are
actually inspectable. Used to settle disputed attribute calls by eye.

    python zoom.py page_00 5 6 9 10
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
        _, y0, _, y1 = rows.row_box(i)
        face = page[y0:y1, 20:125]
        big = cv2.resize(face, None, fx=7, fy=7, interpolation=cv2.INTER_LANCZOS4)
        path = OUT / f"zoom_{name}_row{i:02d}.png"
        cv2.imwrite(str(path), big)
        print(path.name)


if __name__ == "__main__":
    main(sys.argv[1:])
