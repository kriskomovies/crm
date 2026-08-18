"""Scrape the live Quick Add roster off the emulator, top to bottom.

    python capture_live.py --out live_roster

Scrolls the real list, captures each screenful, cuts the rows out and drops the
overlap, then composes a contact sheet the eval scripts can read.

The overlap is the whole difficulty. A scrolling capture does not advance by a
whole number of rows -- fling, inertia and the sticky "Quick Add" header all move
it -- so consecutive screens share rows. Nine raw pages covered only 99 accounts
in 126 row-slots on the keyed corpus: 27% duplicates. Here rows are de-duplicated
on a hash of their own pixels, which needs no OCR and no handle to compare.

Swipes are slow on purpose (600ms over a short distance). A fast flick flings the
list an unpredictable distance and can skip rows entirely, which is the one
failure this cannot detect -- a skipped row looks exactly like a row that was
never there.
"""
import argparse
import hashlib
import subprocess
from pathlib import Path

import cv2
import numpy as np

ADB = r"D:\LDPlayer\LDPlayer4.0\adb.exe"
SERIAL = "127.0.0.1:5555"
HERE = Path(__file__).resolve().parent
OUT = HERE / "results"

ROW_PITCH = 100          # from rows.py, measured on this capture geometry
CROP_X = (20, 680)       # avatar + name + handle; drops Add and X


def sh(*args, binary=False):
    r = subprocess.run([ADB, "-s", SERIAL, *args], capture_output=True)
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def screencap():
    raw = sh("exec-out", "screencap", "-p", binary=True)
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    return img


def find_quick_add_top(img):
    """y of the first row, located from the 'Quick Add' header rather than fixed.

    A fixed offset breaks the moment an "Added Me" card appears above the list,
    which it does whenever somebody adds the account back -- i.e. constantly, on
    an account that is working.
    """
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Rows sit on white; the header band and the card above it are grey. Find the
    # last grey-ish band in the top half and start below it.
    band = (g[:, 30:600] < 250).sum(axis=1)
    greyish = np.nonzero(band[: img.shape[0] // 2] > 200)[0]
    return int(greyish.max()) + 12 if len(greyish) else 300


def row_hash(row):
    small = cv2.resize(row, (64, 16), interpolation=cv2.INTER_AREA)
    return hashlib.md5(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).tobytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--screens", type=int, default=12)
    ap.add_argument("--cols", type=int, default=2)
    ap.add_argument("--out", default="live_roster")
    a = ap.parse_args()

    OUT.mkdir(exist_ok=True)
    screens = OUT / "live_screens"
    screens.mkdir(exist_ok=True)
    for old in screens.glob("*.png"):
        old.unlink()
    rows, seen = [], set()

    for s in range(a.screens):
        img = screencap()
        if img is None:
            print("  screencap failed"); break
        # Each screen is kept whole and extracted on its own. Composing them
        # first and extracting once was cheaper and wrong: the scroll overlap
        # put the same person in a batch twice, the model emitted the display
        # name twice while continuing through handles, and every field after
        # that point was paired with the wrong person. A duplicate cannot
        # desynchronise a batch it is not inside.
        cv2.imwrite(str(screens / f"screen_{s:02d}.png"), img)
        top = find_quick_add_top(img) if s == 0 else 180
        h = img.shape[0]
        n_new = 0
        i = 0
        while top + (i + 1) * ROW_PITCH <= h - 40:
            y0 = top + i * ROW_PITCH
            row = img[y0:y0 + ROW_PITCH, CROP_X[0]:CROP_X[1]]
            i += 1
            if row.shape[0] < ROW_PITCH:
                continue
            g = cv2.cvtColor(row, cv2.COLOR_BGR2GRAY)
            if (g < 240).sum() < 400:        # blank strip, not an entry
                continue
            hh = row_hash(row)
            if hh in seen:
                continue
            seen.add(hh)
            rows.append(row)
            n_new += 1
        print(f"  screen {s + 1}: +{n_new} new (total {len(rows)})", flush=True)
        if s and n_new == 0:
            print("  no new rows -- reached the bottom")
            break
        # Slow, short swipe: a flick is unpredictable and can skip rows.
        sh("shell", "input", "swipe", "450", "1200", "450", "400", "600")
        sh("shell", "sleep", "1")

    if not rows:
        print("no rows captured"); return

    w = rows[0].shape[1]
    tiles = list(rows)
    while len(tiles) % a.cols:
        tiles.append(np.full((ROW_PITCH, w, 3), 255, np.uint8))
    grid = np.vstack([np.hstack(tiles[i:i + a.cols])
                      for i in range(0, len(tiles), a.cols)])
    p = OUT / f"{a.out}_{len(rows)}e_{a.cols}c.png"
    cv2.imwrite(str(p), grid)
    print(f"\n{len(rows)} unique rows -> {grid.shape[1]}x{grid.shape[0]}")
    print(f"wrote {p}")


if __name__ == "__main__":
    main()
