"""Where local OCR loses to the VLM: names and name-to-handle association.

ocr_eval.py reports 97/99 handles but only 89/99 names and 86/99 pairs. Those
gaps decide whether OCR can carry the transcription job, so they are itemised
here rather than left as a number: an emoji-only loss is acceptable (the handle
is the dedupe key), a wrongly-paired handle is not (it puts one person's name on
another person's follow).

    D:\\ocr-venv\\Scripts\\python.exe ocr_diff.py
"""
import io
import json
import sys
import unicodedata
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
GT = HERE / "ground_truth.json"
RES = HERE / "results" / "ocr_eval.json"


def is_emoji(c):
    o = ord(c)
    return (unicodedata.category(c) == "So"
            or 0x1F000 <= o <= 0x1FAFF
            or 0x1F3FB <= o <= 0x1F3FF
            or o in (0x200D, 0xFE0F, 0x20E3))


def strip_emoji(s):
    s = unicodedata.normalize("NFKC", str(s or ""))
    return " ".join("".join(c for c in s if not is_emoji(c)).split())


def has_emoji(s):
    return any(is_emoji(c) for c in unicodedata.normalize("NFKC", str(s or "")))


def norm(s):
    return " ".join(unicodedata.normalize("NFKC", str(s or "")).strip().casefold().split())


def roster():
    gt = json.loads(GT.read_text(encoding="utf-8"))["pages"]
    out, seen = [], set()
    for page in sorted(gt):
        for r in gt[page]:
            if r["handle"] in seen:
                continue
            seen.add(r["handle"])
            out.append(r)
    return out


def main():
    res = json.loads(RES.read_text(encoding="utf-8"))
    pairs = [tuple(p) for rows in res["pages"].values() for p in rows]
    people = roster()

    by_handle = {}
    for name, handle in pairs:
        if handle:
            by_handle.setdefault(norm(handle), set()).add(norm(name))

    name_misses, pair_misses = [], []
    for r in people:
        want_name = norm(strip_emoji(r["display_name"]))
        h = norm(r["handle"])
        got = by_handle.get(h, set())
        if want_name not in {n for n in got}:
            (pair_misses if got else name_misses).append(
                (r["handle"], r["display_name"], sorted(got)))

    print(f"=== {len(pair_misses)} entries where the handle was read but the name did not match ===")
    for handle, want, got in pair_misses:
        flag = "EMOJI" if has_emoji(want) else "     "
        print(f"  {flag} @{handle:<22} key {want!r:<30} ocr {got}")

    print(f"\n=== {len(name_misses)} entries whose handle never appeared in any pair ===")
    for handle, want, _ in name_misses:
        print(f"        @{handle:<22} key {want!r}")

    emoji_names = [r for r in people if has_emoji(r["display_name"])]
    print(f"\ndisplay names containing emoji: {len(emoji_names)}/99")
    print("  OCR returns none of them; the CRM's cleanDisplayName KEEPS emoji,")
    print("  so these would be stored with the emoji silently dropped.")

    print(f"\n=== {len(res['invented'])} handle strings matching no roster entry ===")
    for s in res["invented"]:
        print(f"  {s!r}")


if __name__ == "__main__":
    main()
