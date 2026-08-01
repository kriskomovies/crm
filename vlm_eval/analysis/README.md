# analysis/ — the investigations, kept as evidence

Nothing imports these. Each one was written to answer a single question, and
every one of those questions is now settled and recorded in `../APIMART.md` or
`../ROUTING.md`. They are here rather than deleted because the conclusions in
those documents are only trustworthy while the script that produced them can
still be read.

| script | the question it answered | where the answer lives |
|---|---|---|
| `cascade.py` | would a cheap-model first pass pay for itself? | APIMART.md — "The cascade does not pay" |
| `image_tokens.py`, `measure_cost.py`, `solve_price.py` | why does splitting one sheet into many calls cost more? | APIMART.md — "Why more calls costs more" |
| `run_pages.py`, `score_pages.py` | are raw scroll pages better value than one montage? | APIMART.md — "Raw pages are worse value than the sheet" |
| `compare.py`, `nat_compare.py`, `reconcile.py` | is anything close to `gemini-3.6-flash`? | APIMART.md |
| `as_table.py`, `full_table.py`, `side_by_side.py` | the superseded ChatGPT-reference-table comparison | `../table_audit.md` |
| `mistakes.py`, `show_run.py` | which entries did a given run get wrong? | by-eye debugging |
| `zoom.py`, `zoom_cell.py`, `zoom_text.py`, `montage.py` | reading the sheet at high magnification | how `ground_truth.json` was hand-keyed |
| `round2.ps1`, `round3.ps1`, `round4.ps1` | batch drivers for three finished benchmark rounds | RESULTS.md |

## Running one

They were written to live in `vlm_eval/`, so they import `sheet`, `score`,
`apimart` and friends as top-level modules. From this directory that fails.
Run them from the parent with this directory on the path:

```bash
cd vlm_eval && python analysis/cascade.py
```

The three `.ps1` drivers additionally hardcode
`C:\Users\Krisko\Desktop\snap-automation\vlm_eval`, a path that no longer
exists — this project moved to `D:\crm`. Fix the `Set-Location` before running
one, or read it as a record of what was run rather than as a live script.

Most of them also need the contact sheet and the row crops, which are not in
the repository — see the note about `test/` in the root README.
