"""Emit the finished roster: display name, handle, nationality guess.

Name and handle come from the run that scored best -- they are transcription,
so the most accurate reader wins outright. Nationality cannot be sourced that
way, because there is no key to be accurate against: it is taken as a majority
vote across every model that read the entry well, and each row carries how many
models voted and how split they were. A row at 6/14 agreement is a coin flip
dressed up as an answer, and the column says so rather than hiding it.

    python roster_out.py                              # best run, auto-picked
    python roster_out.py sheet_gemini-3.6-flash_r33.json
"""
import csv
import json
import sys
from pathlib import Path

import sheet
from score_sheet import (best_per_model, consensus_nationality, run_files,
                         score_run)

HERE = Path(__file__).resolve().parent


def main(argv):
    roster = sheet.roster()
    scored = []
    for f in run_files():
        run = json.loads(f.read_text(encoding="utf-8"))
        s = score_run(run, roster)
        s["_run"] = run
        s["_file"] = f.name
        scored.append(s)

    if argv:
        want = Path(argv[0]).name
        best = next((s for s in scored if s["_file"] == want), None)
        if best is None:
            raise SystemExit(f"no run file named {want!r}; have: "
                             + ", ".join(sorted(s["_file"] for s in scored)[:8]) + " ...")
    else:
        # Ties on accuracy go to the faster run, so re-running a finalist cannot
        # quietly swap in a slower repeat that scored the same.
        best = max(scored, key=lambda s: (s["handle_exact"], s["name_exact"],
                                          -(s["seconds"] or 9e9)))
    print(f"names/handles from {best['model']} "
          f"({best['handle_exact']}/99 handles, {best['name_exact']}/99 names)")

    voters = best_per_model([s for s in scored if s["handle_exact"] >= 60])
    cons = {c["n"]: c for c in consensus_nationality(voters, roster)}
    print(f"nationality voted by {len(voters)} distinct models")

    pred = {e["n"]: e for e in best["_run"]["entries"]
            if isinstance(e.get("n"), int)}

    rows = []
    for r in roster:
        p = pred.get(r["n"], {})
        c = cons[r["n"]]
        rows.append({
            "n": r["n"],
            "display_name": p.get("display_name") or r["display_name"],
            "handle": p.get("handle") or r["handle"],
            "nationality": c["nationality"],
            "agreement": c["agreement"],
            "votes": c["votes"],
            "runner_up": next((k for k in list(c["alternatives"])[1:2]), ""),
        })

    csv_path = HERE / "roster_with_nationality.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    md = ["# Quick Add roster: name, handle, name-origin guess", "",
          f"Names and handles transcribed by **{best['model']}** "
          f"({best['handle_exact']}/99 handles exact against the pixel-verified key).",
          "",
          "`nationality` is an inference from the name, majority-voted across "
          f"{len(voters)} models. It is **not** verifiable from the screenshot -- "
          "a username cannot establish anyone's nationality -- so `agreement` "
          "is given for every row and anything under 0.7 should be read as "
          "\"the models disagreed\".", "",
          "| # | display name | handle | name reads as | agreement | runner-up |",
          "|--:|---|---|---|--:|---|"]
    for r in rows:
        md.append(f"| {r['n']} | {r['display_name']} | `{r['handle']}` | "
                  f"{r['nationality']} | {r['agreement']:.0%} | {r['runner_up']} |")
    md_path = HERE / "roster_with_nationality.md"
    md_path.write_text("\n".join(md) + "\n", encoding="utf-8")

    firm = sum(1 for r in rows if r["agreement"] >= 0.8)
    print(f"\n{len(rows)} rows, {firm} with >=80% agreement on origin")
    print(f"-> {csv_path}\n-> {md_path}")


if __name__ == "__main__":
    main(sys.argv[1:])
