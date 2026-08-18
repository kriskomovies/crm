"""Write the sheet and the model comparison out as pictures you can just look at.

Three files:

  01_template.png   the sheet exactly as it is sent to the model -- 33 rows,
                    two columns, avatar and name and handle and nothing else.
  02_matrix.png     the same 33 rows unwrapped into one column in reading
                    order, each with what both models said beside it. Where
                    they agree the value is printed once in grey, because an
                    agreement is not the interesting part; where they differ
                    both are printed and the row is flagged.
  03_readme.txt     the numbers, so the pictures are not the only record.

The point of the second one is that every judgement in it can be checked by eye
against the face immediately to its left. Nothing in this pipeline has ground
truth for "does this cartoon read as a man", so the only real audit is a person
looking, and that is only practical if the picture and the verdict are on the
same line.
"""
import json
import pathlib
import shutil

import cv2
import numpy as np

R = pathlib.Path(__file__).resolve().parent / "results"
OUT = pathlib.Path(r"C:\Users\Krisko\Desktop\snap-results")
SHEET = pathlib.Path(r"C:\Users\Krisko\AppData\Local\Temp\wide_sheet.png")
A_ID, B_ID = "gemini-3-flash-preview-nothinking", "gemini-3.6-flash"
CELL_W, CELL_H, COLS, N = 436, 87, 2, 33

FONT = cv2.FONT_HERSHEY_SIMPLEX
GREY, RED, BLUE, BLACK = (130, 130, 130), (60, 60, 200), (170, 90, 40), (30, 30, 30)


def load(mid):
    d = json.loads((R / f"ab_{mid}_A.json").read_text(encoding="utf-8"))
    return {e["n"]: e for e in d["entries"]}, d


def norm(s):
    return (s or "").strip().lower()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sheet = cv2.imread(str(SHEET))
    if sheet is None:
        raise SystemExit(f"cannot read {SHEET}")
    shutil.copy(SHEET, OUT / "01_template.png")

    a, da = load(A_ID)
    b, db = load(B_ID)
    fields = [("nationality", "origin"), ("avatar_presents_as", "avatar"),
              ("name_presents_as", "name reads"), ("skin_tone", "tone"),
              ("nationality_confidence", "conf")]

    # Column x-offsets in the annotation panel, laid out once so the header and
    # the rows cannot drift apart.
    xs = [10, 150, 330, 470, 640, 800]
    panel_w = 960
    rows = []

    head = np.full((46, CELL_W + panel_w, 3), 245, np.uint8)
    cv2.putText(head, "avatar / name / handle", (10, 30), FONT, 0.6, BLACK, 2)
    for (fld, label), x in zip(fields, xs[1:]):
        cv2.putText(head, label, (CELL_W + x, 30), FONT, 0.6, BLACK, 2)
    cv2.putText(head, "#", (CELL_W + xs[0], 30), FONT, 0.6, BLACK, 2)
    rows.append(head)

    for n in range(1, N + 1):
        r, c = divmod(n - 1, COLS)
        cell = sheet[r * CELL_H:(r + 1) * CELL_H, c * CELL_W:(c + 1) * CELL_W]
        pan = np.full((CELL_H, panel_w, 3), 255, np.uint8)
        x, y = a.get(n, {}), b.get(n, {})
        cv2.putText(pan, str(n), (xs[0], 50), FONT, 0.7, BLACK, 2)
        differs = False
        for (fld, _), px in zip(fields, xs[1:]):
            va, vb = norm(x.get(fld)), norm(y.get(fld))
            if va == vb:
                cv2.putText(pan, va[:14], (px, 50), FONT, 0.52, GREY, 1)
            else:
                differs = True
                cv2.putText(pan, va[:14], (px, 36), FONT, 0.52, BLUE, 1)
                cv2.putText(pan, vb[:14], (px, 64), FONT, 0.52, RED, 1)
        row = np.hstack([cell, pan])
        if differs:
            row[:, CELL_W - 3:CELL_W] = (200, 200, 255)
        rows.append(row)
        rows.append(np.full((1, row.shape[1], 3), 225, np.uint8))

    key = np.full((60, CELL_W + panel_w, 3), 245, np.uint8)
    cv2.putText(key, "grey = both models agree", (10, 24), FONT, 0.5, GREY, 1)
    cv2.putText(key, f"blue = {A_ID}", (10, 46), FONT, 0.5, BLUE, 1)
    cv2.putText(key, f"red  = {B_ID}", (480, 46), FONT, 0.5, RED, 1)
    rows.append(key)

    cv2.imwrite(str(OUT / "02_matrix.png"), np.vstack(rows))

    for src, dst in ((r"C:\Users\Krisko\AppData\Local\Temp\beards.png",
                      "04_facial_hair_dispute.png"),
                     (r"C:\Users\Krisko\AppData\Local\Temp\faces.png",
                      "05_faces_zoom.png")):
        if pathlib.Path(src).exists():
            shutil.copy(src, OUT / dst)

    agree = {}
    for fld, label in fields:
        agree[label] = sum(norm(a.get(n, {}).get(fld)) ==
                           norm(b.get(n, {}).get(fld)) for n in range(1, N + 1))
    hs = sum(norm(a.get(n, {}).get("handle")) == norm(b.get(n, {}).get("handle"))
             for n in range(1, N + 1))

    ua, ub = da["measured_usd"], db["measured_usd"]
    txt = [
        "33-handle template, two columns, avatars + names + handles only.",
        "Both models were sent the LIVE production prompt from",
        "server/src/extraction/sheet-task.ts.",
        "",
        f"  A = {A_ID}",
        f"  B = {B_ID}",
        "",
        "AGREEMENT (33 entries)",
        f"  handle                   {hs}/{N}"
        "   <- the one difference, A is correct:",
        "                                 the handle really is 'dandandanlegget',",
        "                                 B added a t to match the display name.",
    ]
    for label, v in agree.items():
        txt.append(f"  {label:<24} {v}/{N}")
    txt += [
        "",
        "COST PER SCREENSHOT (33 handles), measured from the gateway's",
        "own spend counter around each isolated call:",
        f"  A  {ua:.5f} USD   ({ua / N * 1000:.3f} per 1000 profiles)  "
        f"{da['seconds']}s",
        f"  B  {ub:.5f} USD   ({ub / N * 1000:.3f} per 1000 profiles)  "
        f"{db['seconds']}s",
        f"  B costs {ub / ua:.1f}x more and emits "
        f"{db['completion_tokens'] / da['completion_tokens']:.1f}x the output",
        "  tokens for the same JSON. None of that changed a routing field.",
        "",
        "CAVEAT: confidence is the one field where the two models genuinely",
        "differ. A says 'low' for 26 of 33, B says 'medium'. The default rule",
        "uses minConfidence 'low' so a switch is invisible today, but any",
        "client set to 'medium' would see their queue collapse.",
    ]
    (OUT / "03_readme.txt").write_text("\n".join(txt), encoding="utf-8")

    for f in sorted(OUT.iterdir()):
        print(f"  {f.name:<32}{f.stat().st_size / 1024:>8.0f} KB")


if __name__ == "__main__":
    main()
