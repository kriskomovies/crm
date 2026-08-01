"""Build one table of every person across all nine pages, in the column layout of
the original ChatGPT table.

Two merges happen here, both of which recover accuracy that either run alone
loses:

1. Across runs. Page mode reads text best (99.4% character accuracy on handles)
   but barely answers attribute questions, because at one-page scale each avatar
   is only ~60px. Row mode is the reverse. So names and handles come from the
   page-mode run and avatar attributes from the row-mode run.

2. Across pages. The captures are a scrolling sequence, so most people appear on
   two consecutive pages -- 122 rows, 99 actual people. Duplicates are merged by
   handle, and where one reading left an attribute blank and the other filled it,
   the filled one wins. Seeing the same avatar twice is a second chance at it.

    python full_table.py            # markdown to stdout + full_roster.md / .csv
"""
import csv
import json
from pathlib import Path

import score

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"

ATTRS = ["facial_hair", "skin_tone", "gender_presentation"]
BLANK = "—"


def load(name):
    return json.loads((RESULTS / name).read_text(encoding="utf-8"))


def find_key(out, handle, name):
    """Existing key for this person, tolerating the model's own handle typos.

    Exact keying over-counts: the same person read twice can come back as
    `kadenm_o6` and `kademm_06`, which would list them as two people. A near-
    identical handle plus a near-identical display name is the same row seen on
    two overlapping pages, so those merge."""
    if handle in out:
        return handle
    for k, v in out.items():
        if abs(len(k) - len(handle)) <= 2 and score.levenshtein(k, handle) <= 2:
            other = v["vals"].get("display_name", "")
            if score.similarity(other, name) >= 0.7:
                return k
    return handle


def rows_by_handle(run):
    """Every prediction keyed by handle, remembering which pages it came from."""
    out = {}
    for page, payload in run["pages"].items():
        for r in payload.get("rows", []):
            h = str(r.get("handle") or "").strip().casefold()
            if not h:
                continue
            h = find_key(out, h, str(r.get("display_name") or ""))
            cur = out.setdefault(h, {"pages": [], "vals": {}})
            cur["pages"].append(page.replace("page_", ""))
            for k, v in r.items():
                v = str(v or "").strip()
                # First non-blank answer wins; a later blank never overwrites it.
                if v and not cur["vals"].get(k):
                    cur["vals"][k] = v
    return out


def main():
    page_run, row_run = load("ollama_qwen2.5vl_7b_page_both.json"), \
                        load("ollama_qwen2.5vl_7b_row_both.json")
    text, attrs = rows_by_handle(page_run), rows_by_handle(row_run)

    # Page mode missed no rows, so it defines the roster; row mode only enriches.
    order = []
    for page in sorted(page_run["pages"]):
        for r in sorted(page_run["pages"][page].get("rows", []),
                        key=lambda x: x.get("position") or 0):
            h = str(r.get("handle") or "").strip().casefold()
            h = find_key(text, h, str(r.get("display_name") or ""))
            if h and h not in order:
                order.append(h)
    for h in attrs:                       # anything only row mode saw
        if h not in order and not any(score.levenshtein(h, o) <= 2 for o in order):
            order.append(h)

    table = []
    for i, h in enumerate(order, 1):
        t = text.get(h, {"vals": {}, "pages": []})
        a = attrs.get(h) or next(
            (v for k, v in attrs.items() if score.levenshtein(k, h) <= 2),
            {"vals": {}, "pages": []})
        merged = {k: (t["vals"].get(k) or a["vals"].get(k) or "") for k in
                  ["display_name", "handle"] + ATTRS}
        # Attributes: prefer row mode, fall back to page mode.
        for k in ATTRS:
            merged[k] = a["vals"].get(k) or t["vals"].get(k) or ""
        pages = sorted(set(t["pages"]) | set(a["pages"]))
        table.append({"n": i, **merged, "pages": ",".join(pages)})

    md = ["| # | Display name | Handle | Beard / Moustache | Skin tone | Gender | Pages |",
          "|---|---|---|---|---|---|---|"]
    for r in table:
        md.append("| {n} | {display_name} | `{handle}` | {facial_hair} | {skin_tone} "
                  "| {gender_presentation} | {pages} |".format(
                      **{k: (v if str(v).strip() else BLANK) if k != "n" else v
                         for k, v in r.items()}))
    out_md = "\n".join(md)
    print(out_md)

    (HERE / "full_roster.md").write_text(
        f"# Quick Add roster — {len(table)} people across 9 pages\n\n"
        "Names and handles from the page-mode run, avatar attributes from the\n"
        "row-mode run, duplicates merged by handle. Blank means the model\n"
        "declined to answer, which it does often for attributes — see\n"
        "RESULTS.md before trusting those columns.\n\n" + out_md + "\n",
        encoding="utf-8")

    with (HERE / "full_roster.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["n", "display_name", "handle",
                                          "facial_hair", "skin_tone",
                                          "gender_presentation", "pages"])
        w.writeheader()
        w.writerows(table)

    print(f"\n{len(table)} unique people -> full_roster.md, full_roster.csv")


if __name__ == "__main__":
    main()
