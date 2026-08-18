"""Build the four format variants of the SAME 99 keyed people, plus a manifest.

    python fmt_build.py            # writes results/fmt/*.png + fmt_manifest.json
    python fmt_build.py --dry-run  # geometry only, writes nothing

WHAT IS BEING SEPARATED
-----------------------
The operator's hypothesis bundles two different changes together -- "fewer
entries per image" and "bigger cells" -- and every prior run changed both at
once, so nothing on disk says which one does the work. These four variants pull
them apart:

    V1   99 entries  3 cols  345px cells   scale 1.0   <- production today
    V2   33 entries  2 cols  436px cells   scale 1.264 <- remembered format
    V3   33 entries  1 col   690px cells   scale 2.0   <- "bigger" pushed further
    V4   99 entries  3 cols  690px cells   scale 2.0   <- pixels ONLY

V1 vs V4 holds entries constant and doubles the pixels. V3 vs V4 holds the cell
width constant at 690 and cuts entries from 99 to 33. Between those two pairs
every cell of the 2x2 is covered, which is the only way the answer comes out
attributable rather than merely different.

THE HONEST CAVEAT, STATED IN THE MANIFEST TOO
---------------------------------------------
345px is the NATIVE capture width -- production's snapclient/sheet.py crops
LIST_X0=37, CELL_W=345 straight out of the device framebuffer and never
rescales. So there is no such thing as a genuinely "bigger" cell available to
us: V2, V3 and V4 are all INTERPOLATION. They add pixels, not detail. That is
still worth measuring, because what a VLM sees is a resampled tile budget and
an avatar's SHARE of it -- but a win here means "resampling helps the model",
never "we captured more of the face".

Cells are cut at native 345x87 and only then resized as a separate, labelled
step. Nothing is ever resampled during the cut.

ONE KERNEL EVERYWHERE
---------------------
Every upscale uses cv2.INTER_CUBIC. The brief fixes CUBIC for V4; using
sheet.upscale()'s LANCZOS4 for V2/V3 would have made the V3-vs-V4 comparison
differ in interpolation kernel as well as in entry count, turning the cleanest
pair in the matrix into a confounded one. One kernel, recorded in the manifest.

PNG throughout, never JPEG: the hypothesis under test is literally "better
quality", so compression artefacts must not be one of the moving parts.
"""
import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np

import sheet

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
OUT = HERE / "results" / "fmt"
MANIFEST = HERE / "results" / "fmt_manifest.json"

INTERP = "INTER_CUBIC"
_INTERP = cv2.INTER_CUBIC

# (tag, entries_per_image, cols, cell_w)  -- cell_h follows by aspect ratio
VARIANTS = [
    ("V1", 99, 3, 345),
    ("V2", 33, 2, 436),
    ("V3", 33, 1, 690),
    ("V4", 99, 3, 690),
]


def cut(img, n):
    """The native 345x87 cell holding roster position `n` (1-based).

    Same divmod the scorers use (dense_sheet.py:62-65, avatar_eval.py:96-100),
    so position N is the same person here as it is in the key.
    """
    r, c = divmod(n - 1, sheet.COLS)
    return img[r * sheet.CELL_H:(r + 1) * sheet.CELL_H,
               c * sheet.CELL_W:(c + 1) * sheet.CELL_W]


def ink_width(cell, thresh=235):
    """Rightmost non-background column -- proves no glyph is being lost."""
    g = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
    cols = np.nonzero((g < thresh).any(axis=0))[0]
    return int(cols.max()) + 1 if len(cols) else sheet.CELL_W


def tile(img, positions, cols, cell_w):
    """-> (image, cell_h, blank_cells). Reading order left-to-right, top-down.

    Cut native, resize once, then stack. A short final row is padded with white
    cells rather than a narrower row, so the grid the model sees is rectangular
    and every cell pitch is identical.
    """
    cell_h = round(sheet.CELL_H * cell_w / sheet.CELL_W)
    tiles = []
    for n in positions:
        c = cut(img, n)
        if (cell_w, cell_h) != (sheet.CELL_W, sheet.CELL_H):
            c = cv2.resize(c, (cell_w, cell_h), interpolation=_INTERP)
        tiles.append(c)

    blank = (-len(tiles)) % cols
    rows = []
    for s in range(0, len(tiles), cols):
        chunk = tiles[s:s + cols]
        while len(chunk) < cols:
            chunk.append(np.full((cell_h, cell_w, 3), 255, np.uint8))
        rows.append(np.hstack(chunk))
    return np.vstack(rows), cell_h, blank


def build(dry_run=False):
    img = sheet.load_sheet()
    roster = sheet.roster()                      # asserts 99 unique handles
    by_n = {r["n"]: r for r in roster}

    widest = max(ink_width(cut(img, n)) for n in by_n)
    if widest > sheet.CELL_W:
        raise SystemExit(f"ink reaches x={widest} inside a {sheet.CELL_W}px "
                         f"cell -- a display name would be cut")

    if not dry_run:
        OUT.mkdir(parents=True, exist_ok=True)

    manifest = {
        "_about": "Format variants of the SAME 99 keyed people. `positions` are "
                  "1-based ground-truth roster positions (sheet.roster()), so a "
                  "33-entry image scores against the 99-key by position.",
        "_caveat": f"{sheet.CELL_W}px is the NATIVE capture width (production "
                   f"snapclient/sheet.py LIST_X0=37 CELL_W=345, never rescaled). "
                   f"Any cell_w above {sheet.CELL_W} is interpolation, not extra "
                   f"detail. Cells are always cut at native size first; the "
                   f"resize is a separate labelled step.",
        "source": str(sheet.SHEET),
        "source_sha256": hashlib.sha256(sheet.SHEET.read_bytes()).hexdigest(),
        "ground_truth": str(sheet.GT),
        "native_cell": {"w": sheet.CELL_W, "h": sheet.CELL_H},
        "widest_ink_px": widest,
        "interp": INTERP,
        "format": "png",
        "variants": [],
    }

    for tag, per_img, cols, cell_w in VARIANTS:
        scale = cell_w / sheet.CELL_W
        images = []
        for start in range(0, sheet.N_ENTRIES, per_img):
            positions = list(range(start + 1,
                                   min(start + per_img, sheet.N_ENTRIES) + 1))
            im, cell_h, blank = tile(img, positions, cols, cell_w)
            name = (f"{tag.lower()}_{len(positions)}e_{cols}c_{cell_w}px"
                    f"_{positions[0]:02d}-{positions[-1]:02d}.png")
            p = OUT / name
            if not dry_run:
                if not cv2.imwrite(str(p), im):
                    raise SystemExit(f"failed to write {p}")
            images.append({
                "file": name,
                "path": str(p),
                "width": int(im.shape[1]),
                "height": int(im.shape[0]),
                "bytes": p.stat().st_size if p.exists() else None,
                "grid_rows": (len(positions) + cols - 1) // cols,
                "blank_cells": blank,
                "n_entries": len(positions),
                "positions": positions,
                "handles": [by_n[n]["handle"] for n in positions],
            })

        manifest["variants"].append({
            "tag": tag,
            "role": {"V1": "control -- production geometry, native pixels",
                     "V2": "operator's remembered format",
                     "V3": "bigger cells pushed further",
                     "V4": "pixels only -- V1 entry count at V3 cell width",
                     }[tag],
            "entries_per_image": per_img,
            "cols": cols,
            "cell_w": cell_w,
            "cell_h": round(sheet.CELL_H * cell_w / sheet.CELL_W),
            "scale": round(scale, 5),
            "rescaled": cell_w != sheet.CELL_W,
            "interp": INTERP if cell_w != sheet.CELL_W else None,
            "n_images": len(images),
            "total_entries": sum(i["n_entries"] for i in images),
            "images": images,
        })

    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    m = build(a.dry_run)

    print(f"source {Path(m['source']).name}  sha {m['source_sha256'][:12]}  "
          f"widest ink {m['widest_ink_px']}px in a {m['native_cell']['w']}px cell")
    for v in m["variants"]:
        note = f"{v['interp']} x{v['scale']}" if v["rescaled"] else "NATIVE"
        print(f"\n{v['tag']}  {v['entries_per_image']}e x {v['cols']}c  "
              f"cell {v['cell_w']}x{v['cell_h']}  {note}  "
              f"-- {v['n_images']} image(s), {v['total_entries']} entries")
        for i in v["images"]:
            mpx = i["width"] * i["height"] / 1e6
            kb = (i["bytes"] or 0) / 1024
            print(f"    {i['file']:<40} {i['width']:>5}x{i['height']:<5} "
                  f"{mpx:6.2f} Mpx {kb:9.1f} KiB  "
                  f"pos {i['positions'][0]}-{i['positions'][-1]}"
                  + (f"  ({i['blank_cells']} blank)" if i["blank_cells"] else ""))

    seen = [n for v in m["variants"] for i in v["images"] for n in i["positions"]]
    per_variant = {v["tag"]: sorted({n for i in v["images"]
                                     for n in i["positions"]})
                   for v in m["variants"]}
    assert all(p == list(range(1, sheet.N_ENTRIES + 1))
               for p in per_variant.values()), "a variant does not cover all 99"
    print(f"\nevery variant covers positions 1-{sheet.N_ENTRIES}, "
          f"{len(seen)} tiles total")

    if not a.dry_run:
        MANIFEST.write_text(json.dumps(m, indent=2), encoding="utf-8")
        print(f"wrote {MANIFEST}")


if __name__ == "__main__":
    main()
