"""Sanity-check the scorer without a model, by feeding it predictions whose
correct score is known in advance.

Worth having because every number this harness reports depends on the aligner
pairing the right rows, and an aligner bug is silent -- it shows up as a
plausible-looking accuracy, not as a crash.

    python selftest.py
"""
import copy
import json
import sys
from pathlib import Path

import score

HERE = Path(__file__).resolve().parent


def case(name, gt_rows, mutate, expect):
    pred = copy.deepcopy(gt_rows)
    mutate(pred)
    payload = {"provider": f"selftest/{name}", "mode": "row", "task": "both",
               "fields": ["display_name", "handle", "facial_hair", "skin_tone"],
               "pages": {"page_00": {"rows": pred, "calls": []}}, "total_seconds": 0}
    tmp = HERE / "_selftest.json"
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    r = score.score_file(tmp, {"page_00": gt_rows})
    tmp.unlink()

    got = {"missed": r["missed"], "spurious": r["spurious"],
           "handle_exact": r["tally"]["handle"]["exact"]}
    ok = all(got[k] == v for k, v in expect.items())
    print(f"  {'PASS' if ok else 'FAIL'}  {name:<34} {got}")
    if not ok:
        print(f"        expected {expect}")
    return ok


def main():
    gt = json.loads((HERE / "ground_truth.json").read_text(encoding="utf-8"))
    rows = [r for r in gt["pages"]["page_00"]]
    n = len(rows)
    print(f"scorer self-test against {n} hand-verified rows\n")

    ok = []
    ok.append(case("perfect copy", rows, lambda p: None,
                   {"missed": 0, "spurious": 0, "handle_exact": n}))

    ok.append(case("drops row 5", rows, lambda p: p.pop(4),
                   {"missed": 1, "spurious": 0, "handle_exact": n - 1}))

    def hallucinate(p):
        p.append({"position": 99, "display_name": "Ghost User",
                  "handle": "ghost_zzz999", "facial_hair": "none",
                  "skin_tone": "light"})
    ok.append(case("invents an extra row", rows, hallucinate,
                   {"missed": 0, "spurious": 1, "handle_exact": n}))

    def shuffle(p):
        p.reverse()   # order must not matter; alignment is by handle
    ok.append(case("returns rows reversed", rows, shuffle,
                   {"missed": 0, "spurious": 0, "handle_exact": n}))

    def typo_handles(p):
        for r in p[:3]:
            r["handle"] = r["handle"][:-1] + "x"
    ok.append(case("3 handles off by one char", rows, typo_handles,
                   {"missed": 0, "spurious": 0, "handle_exact": n - 3}))

    # The point of the emoji split: a model that nails the text but guesses the
    # emoji wrong must still score full marks on display_name_text.
    def wrong_emoji(p):
        for r in p:
            r["display_name"] = score.strip_emoji(r["display_name"]) + "🎈"
    pred = copy.deepcopy(rows)
    wrong_emoji(pred)
    payload = {"provider": "selftest/emoji", "mode": "row", "task": "read",
               "fields": ["display_name", "handle"],
               "pages": {"page_00": {"rows": pred, "calls": []}}, "total_seconds": 0}
    tmp = HERE / "_selftest.json"
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    r = score.score_file(tmp, {"page_00": rows})
    tmp.unlink()
    t = r["tally"][score.DERIVED_TEXT]["exact"]
    good = t == n and r["emoji"]["exact"] == 0
    print(f"  {'PASS' if good else 'FAIL'}  {'wrong emoji, right text':<34} "
          f"{{'text_exact': {t}, 'emoji_exact': {r['emoji']['exact']}}}")
    if not good:
        print(f"        expected text_exact={n}, emoji_exact=0")
    ok.append(good)

    print(f"\n{sum(ok)}/{len(ok)} passed")
    return 0 if all(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
