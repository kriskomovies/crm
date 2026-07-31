"""Merge the multi-agent readings of pages 01-08 into ground_truth.json.

page_00 is hand-keyed in ground_truth.json and is never touched here -- it was
verified glyph by glyph at high zoom and is the row the ChatGPT table covers.
The remaining pages come from the extraction agents, whose transcriptions
matched the hand-verified page_00 exactly on all 14 rows, which is the reason
they are trusted for the rest.

Overlap is expected: the captures are a scrolling sequence, so the top rows of
each page repeat the bottom rows of the previous one. Rows are keyed by handle,
and a handle seen twice must agree -- disagreements are reported rather than
silently resolved, since they mark exactly the rows a human should re-check.

    python build_gt.py <journal.jsonl>
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GT = HERE / "ground_truth.json"

ATTRS = ["facial_hair", "headwear", "eyewear", "hair_color", "skin_tone",
         "gender_presentation"]


def clean_name(s):
    """Strip explanatory asides an extraction agent wrote into the name itself.

    Some rows came back as `ryan ▯ (trailing glyph renders as an unsupported
    character, cannot be identified)` -- the parenthetical is the agent talking
    about the name, not part of it. Left in, it becomes prose the model is graded
    against, which silently tanks character accuracy on rows it actually read
    correctly. Names in this corpus never legitimately contain brackets."""
    return " ".join(re.sub(r"[\(\[][^)\]]*[\)\]]", " ", str(s or "")).split())


def load_roster(journal):
    """Pull every {page, rows} payload out of a workflow journal."""
    pages = {}
    for line in Path(journal).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        r = rec.get("result")
        if isinstance(r, dict) and r.get("page") and isinstance(r.get("rows"), list):
            pages[r["page"]] = r["rows"]
    return pages


def main(argv):
    if not argv:
        raise SystemExit(__doc__)
    gt = json.loads(GT.read_text(encoding="utf-8"))
    pages = load_roster(argv[0])
    if not pages:
        raise SystemExit("no page payloads found in that journal")

    for page in sorted(pages):
        rows = []
        for r in pages[page]:
            if r.get("partial_row") or not r.get("handle"):
                continue          # clipped rows are unreadable, not ground truth
            rows.append({"position": r.get("position"),
                         "display_name": clean_name(r.get("display_name", "")),
                         "handle": r["handle"].strip(),
                         **{a: r.get(a, "") for a in ATTRS}})
        gt["pages"][page] = rows
        print(f"{page}: {len(rows)} rows")

    # Cross-page agreement check on the scroll overlap.
    seen, conflicts = {}, []
    for page in sorted(gt["pages"]):
        for r in gt["pages"][page]:
            h = r["handle"]
            if h in seen:
                for f in ["display_name"] + ATTRS:
                    a, b = str(seen[h][1].get(f, "")), str(r.get(f, ""))
                    if a.strip().casefold() != b.strip().casefold():
                        conflicts.append((h, f, seen[h][0], a, page, b))
            else:
                seen[h] = (page, r)

    total = sum(len(v) for v in gt["pages"].values())
    print(f"\n{total} rows across {len(gt['pages'])} pages, {len(seen)} unique handles")
    if conflicts:
        print(f"\n{len(conflicts)} cross-page disagreements (re-check these by eye):")
        for h, f, p1, a, p2, b in conflicts[:40]:
            print(f"  {h:<20} {f:<20} {p1}={a!r:<24} {p2}={b!r}")

    GT.write_text(json.dumps(gt, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n-> {GT}")


if __name__ == "__main__":
    main(sys.argv[1:])
