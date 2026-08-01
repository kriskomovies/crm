"""Print a run's predictions in the column layout of the original ChatGPT table,
so the two can be read side by side.

    python as_table.py                              # local model, page_00
    python as_table.py page00only_row.json page_00  # a specific run/page
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def cell(s, width):
    s = str(s or "").strip() or "-"
    return s if len(s) <= width else s[:width - 1] + "…"


def main(argv):
    name = argv[0] if argv else "ollama_qwen2.5vl_7b_page_both.json"
    page = argv[1] if len(argv) > 1 else "page_00"

    data = json.loads((RESULTS / name).read_text(encoding="utf-8"))
    gt = json.loads((HERE / "ground_truth.json").read_text(encoding="utf-8"))
    truth = {r["position"]: r for r in gt["pages"][page]}
    rows = sorted(data["pages"][page]["rows"], key=lambda r: r.get("position") or 0)

    print(f"\n{data['provider']}  [mode={data['mode']}]  {page}\n")
    hdr = (f"{'#':<3} {'Display name':<24} {'Handle':<17} "
           f"{'Beard / Moustache':<18} {'Skin tone':<12} {'Gender':<8}")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        pos = r.get("position")
        print(f"{pos or '?':<3} {cell(r.get('display_name'), 24):<24} "
              f"{cell(r.get('handle'), 17):<17} "
              f"{cell(r.get('facial_hair'), 18):<18} "
              f"{cell(r.get('skin_tone'), 12):<12} "
              f"{cell(r.get('gender_presentation'), 8):<8}")

    print("\n\nagainst the verified key (only rows where they differ):\n")
    diff = f"{'#':<3} {'field':<14} {'model said':<26} {'image shows':<26}"
    print(diff)
    print("-" * len(diff))
    any_diff = False
    for r in rows:
        t = truth.get(r.get("position"))
        if not t:
            continue
        for f, label in (("display_name", "display name"), ("handle", "handle"),
                         ("facial_hair", "beard/moust"), ("skin_tone", "skin tone")):
            a, b = str(r.get(f, "")).strip(), str(t.get(f, "")).strip()
            if a.casefold() != b.casefold():
                any_diff = True
                print(f"{r['position']:<3} {label:<14} {cell(a, 26):<26} {cell(b, 26):<26}")
    if not any_diff:
        print("(none)")


if __name__ == "__main__":
    main(sys.argv[1:])
