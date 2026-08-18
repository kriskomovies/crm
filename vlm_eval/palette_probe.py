"""Is the Bitmoji face colour a fixed palette? Then skin tone needs no model.

The claim worth testing before paying anything to read an avatar: Bitmoji does
not paint a face an arbitrary colour, it picks from a small fixed set. If that
holds, skin_tone is a lookup -- deterministic, instant, free, and auditable in a
way no classifier is. If it does not hold, the idea dies here and we know why.

The test is deliberately blunt. Take the modal colour of a central patch of each
avatar, count how many DISTINCT values occur across all 99, and cross-tabulate
them against the hand-keyed skin_tone in ground_truth.json.

    python palette_probe.py

Nothing here is trained and nothing is guessed: a palette either shows up as a
handful of exactly-repeated RGB triples, or it does not.
"""
import collections
import json
from pathlib import Path

import cv2
import numpy as np

import avatar_eval
import sheet

HERE = Path(__file__).resolve().parent


def truth_by_handle():
    """handle -> the keyed row. The pages overlap, so first sighting wins."""
    gt = json.loads((HERE / "ground_truth.json").read_text(encoding="utf-8"))
    out = {}
    for page in gt["pages"].values():
        rows = page["rows"] if isinstance(page, dict) and "rows" in page else page
        for r in rows:
            h = (r.get("handle") or "").strip().lower()
            if h and h not in out:
                out[h] = r
    return out


def avatars():
    """(n, handle, 74x82 BGR crop) for all 99, in sheet reading order."""
    img = sheet.load_sheet()
    roster = sheet.roster()
    for i, entry in enumerate(roster):
        r, c = divmod(i, sheet.COLS)
        cell = img[r * sheet.CELL_H:(r + 1) * sheet.CELL_H,
                   c * sheet.CELL_W:(c + 1) * sheet.CELL_W]
        av = cell[avatar_eval.AV_Y[0]:avatar_eval.AV_Y[1],
                  avatar_eval.AV_X[0]:avatar_eval.AV_X[1]]
        yield i + 1, (entry.get("handle") or "").strip().lower(), av


def face_colour(av):
    """Modal colour of the skin-hue pixels in the whole avatar.

    A fixed box does not work and it is worth saying why: the head is not
    centred in the disc, and it moves with the hairstyle and any hat, so a patch
    that lands on a cheek for one avatar lands on the grey disc background for
    the next. The first attempt at this sampled #EAEDEF -- the background -- for
    93 of 99, which looks exactly like "there is one skin colour" until you draw
    the box on the image and see it sitting beside the face.
    Hue finds the skin wherever it is. Bitmoji fills are flat, so the mode of the
    masked pixels is the fill itself rather than an anti-aliased average.
    """
    hsv = cv2.cvtColor(av, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    mask = (((h <= 25) | (h >= 170)) & (s >= 40) & (s <= 190) & (v >= 90))
    mask = mask.astype(np.uint8)

    # Hue alone is not enough: mid-brown hair and an orange beanie both sit in
    # the same band as skin, and taking the mode over the whole mask picked
    # those often enough to destroy the ordering (Spearman 0.086 against the
    # keyed tone, with "pale" measuring darker than "light").
    #
    # The face is the largest CONTIGUOUS run of skin on a head-and-shoulders
    # portrait, so keep the biggest connected component and ignore the rest.
    # Hair is a ring around it and a hat is separated by the hairline, so both
    # fall away; the failure this cannot fix is a bare-chested avatar, where
    # neck, chest and face merge into one blob -- which is fine, they are all
    # the same fill.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return None
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    if stats[biggest, cv2.CC_STAT_AREA] < 60:   # stylised or non-human
        return None

    # The blob is face AND hair. Brown hair shares skin's hue band and touches
    # the face, so the component merges them and the mode lands on whichever is
    # larger -- which for a heavy fringe is the hair. Drawing the mask on the
    # image is what showed this; the number alone just looked like noise.
    #
    # So anchor on the eyes. The sclera is the only near-white, near-zero
    # saturation region inside a face, which makes it findable without a
    # detector, and the cheeks are directly below it. Everything above the eye
    # line is discarded, which is where all the hair is.
    eyes = ((s < 30) & (v > 200)).astype(np.uint8)
    eyes[labels != biggest] = 0                 # sclera inside the face only
    ys = np.nonzero(eyes.any(axis=1))[0]
    face = np.zeros_like(mask)
    face[labels == biggest] = 1
    if len(ys):
        face[: int(ys.mean()) + 2, :] = 0       # drop hair above the eye line
    if face.sum() < 40:
        face[labels == biggest] = 1             # no eyes found: take what we had

    skin = av[face == 1]
    counts = collections.Counter(map(tuple, skin))
    return counts.most_common(1)[0][0]


def main():
    truth = truth_by_handle()
    rows = []
    for n, handle, av in avatars():
        bgr = face_colour(av)
        t = truth.get(handle, {})
        rows.append({
            "n": n, "handle": handle,
            "bgr": None if bgr is None else [int(v) for v in bgr],
            "hex": None if bgr is None else "#%02X%02X%02X" % (bgr[2], bgr[1], bgr[0]),
            "skin_tone": t.get("skin_tone"),
            "gender": t.get("gender_presentation"),
        })

    seen = [r for r in rows if r["hex"]]
    palette = collections.Counter(r["hex"] for r in seen)
    print(f"{len(seen)}/99 avatars sampled")
    print(f"DISTINCT face colours: {len(palette)}\n")

    print(f"{'hex':<10}{'count':>6}   keyed skin_tone(s)")
    print("-" * 62)
    for hexv, cnt in palette.most_common():
        tones = collections.Counter(r["skin_tone"] for r in seen if r["hex"] == hexv)
        pretty = ", ".join(f"{k}x{v}" for k, v in tones.most_common())
        print(f"{hexv:<10}{cnt:>6}   {pretty}")

    # The question that decides whether a lookup is possible at all: does one
    # colour ever carry two different keyed tones?
    ambiguous = [h for h in palette
                 if len({r["skin_tone"] for r in seen if r["hex"] == h}) > 1]
    print(f"\ncolours mapping to more than one keyed tone: {len(ambiguous)}")
    if ambiguous:
        print("  " + ", ".join(ambiguous))

    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "palette_probe.json").write_text(
        json.dumps(rows, indent=1), encoding="utf-8")
    print(f"\nwrote results/palette_probe.json")


if __name__ == "__main__":
    main()
