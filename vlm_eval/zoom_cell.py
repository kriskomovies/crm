"""Blow up one entry of the contact sheet so a disputed glyph can be settled by eye.

Used when several independent models agree against ground_truth.json. That is
the signal that the key -- which was keyed by a human at high zoom -- may be the
thing that is wrong, and an o/0 or a repeated letter is exactly the kind of
character a person miscounts.

    python zoom_cell.py 38 92 4       # entries 38 and 92 at 4x
"""
import sys

import cv2

import sheet


def cell(img, n, scale=6, text_only=True):
    i = n - 1
    r, c = divmod(i, sheet.COLS)
    x0, y0 = c * sheet.CELL_W, r * sheet.CELL_H
    crop = img[y0:y0 + sheet.CELL_H, x0:x0 + sheet.CELL_W]
    if text_only:                       # drop the avatar, keep name + handle
        crop = crop[:, 60:]
    return sheet.upscale(crop, scale)


def main(argv):
    nums = [int(a) for a in argv if a.isdigit()]
    scale = 6
    if len(nums) > 1 and nums[-1] <= 10:
        scale, nums = nums[-1], nums[:-1]
    img = sheet.load_sheet()
    out = sheet.HERE / "crops"
    out.mkdir(exist_ok=True)
    roster = {r["n"]: r for r in sheet.roster()}
    for n in nums:
        p = out / f"cell_{n:02d}.png"
        cv2.imwrite(str(p), cell(img, n, scale))
        print(f"{p}   key: {roster[n]['display_name']!r} / {roster[n]['handle']}")


if __name__ == "__main__":
    main(sys.argv[1:])
