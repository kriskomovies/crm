"""Score results/sheet_*.json against the 99-entry roster.

Two questions are kept apart because they fail for different reasons:

  positional   did entry 17 come back as entry 17? This is the number that
               decides whether the output is usable, because automation has to
               know which row a handle belongs to.
  as a set     was the handle read correctly *anywhere* in the reply? A model
               that reads every handle perfectly but numbers them wrongly --
               because it went down the columns instead of across the rows --
               scores near zero positionally and near perfect here, and that
               gap is a prompt bug, not a vision failure. Reporting only one
               number would hide which.

nationality is not scored against a key and never can be. Nothing in a
screenshot establishes anyone's nationality; the field is a guess about what
origin a name reads as. What is reported is agreement between models on the
entries where they read the same name, which measures consistency, not truth.

    python score_sheet.py                    # every result file
    python score_sheet.py sheet_gpt-5.1_r33.json
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pricing
import sheet
from score import emoji_of, levenshtein, norm_text, strip_emoji

RESULTS = Path(__file__).resolve().parent / "results"
SUMMARIES = {"sheet_scores.json"}       # written here too; not runs


def run_files():
    """Every per-model run file, excluding the summaries this script writes."""
    return sorted(p for p in RESULTS.glob("sheet_*.json")
                  if p.name not in SUMMARIES)


def norm_handle(s):
    return str(s or "").strip().casefold().lstrip("@")


# Glyphs the capture could not render: U+FFFD replacement, and the empty boxes a
# font substitutes for a missing codepoint. They are categorised So, so the emoji
# comparison counts them -- and the prompt explicitly tells the model to omit
# them. Scoring them would mark a model wrong for following the instruction, so
# they come off both sides.
TOFU = {"�", "▯", "□", "■", "⬜", "⬛"}


def emoji_key(s):
    return "".join(c for c in emoji_of(s) if c not in TOFU)


def similarity(a, b):
    if not a and not b:
        return 1.0
    return 1 - levenshtein(a, b) / max(len(a), len(b), 1)


def score_run(run, roster):
    by_n = {r["n"]: r for r in roster}
    truth_handles = {norm_handle(r["handle"]): r["n"] for r in roster}

    pred = {}
    dupes = 0
    for e in run.get("entries", []):
        n = e.get("n")
        if not isinstance(n, int) or not 1 <= n <= sheet.N_ENTRIES:
            continue
        if n in pred:
            dupes += 1
            continue
        pred[n] = e

    s = {"model": run["model"], "rows_per_call": run.get("rows_per_call"),
         "scale": run.get("scale", 1),
         "seconds": run.get("total_seconds"),
         "calls": len(run.get("calls", [])),
         "errors": sum(1 for c in run.get("calls", []) if c.get("error")),
         "truncated": sum(1 for c in run.get("calls", [])
                          if c.get("finish_reason") == "length"),
         "prompt_tokens": run.get("prompt_tokens"),
         "completion_tokens": run.get("completion_tokens"),
         "emitted": len(pred), "duplicate_n": dupes,
         "imputed_n": sum(1 for e in pred.values() if e.get("_imputed_n"))}

    hits = {"handle": 0, "name": 0, "name_emoji": 0}
    err = {"handle": 0, "name": 0}
    length = {"handle": 0, "name": 0}
    blank = {"handle": 0, "name": 0}
    mistakes = []
    for n, want in by_n.items():
        got = pred.get(n, {})
        gh, th = norm_handle(got.get("handle")), norm_handle(want["handle"])
        gn, tn = norm_text(strip_emoji(got.get("display_name"))), \
            norm_text(strip_emoji(want["display_name"]))
        if not str(got.get("handle") or "").strip():
            blank["handle"] += 1
        if not str(got.get("display_name") or "").strip():
            blank["name"] += 1
        hits["handle"] += gh == th
        hits["name"] += gn == tn
        hits["name_emoji"] += emoji_key(got.get("display_name")) == emoji_key(want["display_name"])
        err["handle"] += levenshtein(gh, th)
        err["name"] += levenshtein(gn, tn)
        length["handle"] += max(len(th), 1)
        length["name"] += max(len(tn), 1)
        if gh != th or gn != tn:
            mistakes.append((n, want["display_name"], want["handle"],
                             got.get("display_name", "<missing>"),
                             got.get("handle", "<missing>")))

    for f in ("handle", "name"):
        s[f"{f}_exact"] = hits[f]
        # Clamped at 0: a model whose rows are offset accumulates more edit
        # distance than there are characters in the key, and a negative
        # "accuracy" is just noise. handle_misplaced is what names that failure.
        s[f"{f}_char_acc"] = round(max(0.0, 100 * (1 - err[f] / length[f])), 2)
        s[f"{f}_blank"] = blank[f]
    s["name_emoji_exact"] = hits["name_emoji"]

    # Set view: handle read correctly somewhere, regardless of the number on it.
    seen = {norm_handle(e.get("handle")) for e in pred.values()}
    s["handle_found_anywhere"] = len(seen & set(truth_handles))
    s["handle_invented"] = len([h for h in seen if h and h not in truth_handles])
    # A near-miss on a handle is a misreading; a handle that matches a DIFFERENT
    # entry is an ordering fault. Separating them says which to fix.
    s["handle_misplaced"] = sum(
        1 for n, e in pred.items()
        if norm_handle(e.get("handle")) in truth_handles
        and truth_handles[norm_handle(e.get("handle"))] != n)

    # Cost is quoted per 1000 profiles rather than per run, because 99 is an
    # arbitrary batch size and the decision this feeds is "what does it cost to
    # read the whole Quick Add feed for a week".
    usd = pricing.cost(run["model"], s["prompt_tokens"], s["completion_tokens"])
    s["usd"] = usd
    s["usd_per_1k"] = (round(usd / sheet.N_ENTRIES * 1000, 4)
                       if usd is not None else None)
    s["sec_per_100"] = (round((s["seconds"] or 0) / sheet.N_ENTRIES * 100, 1))

    s["nationality"] = {n: str(e.get("nationality", "")).strip().casefold()
                        for n, e in pred.items()}
    s["nat_conf"] = Counter(str(e.get("nationality_confidence", "")).strip().casefold()
                            for e in pred.values())
    s["mistakes"] = mistakes
    return s


def best_per_model(scores):
    """One run per model id, the best-scoring one.

    Repeat runs exist to measure variance, so counting them as separate voters
    would give a model that ran three times three votes on every nationality --
    turning a repeatability check into a thumb on the scale.
    """
    def rank(s):
        # Ties on accuracy go to the cheaper run. Without this, a model that
        # scored the same at 1 call and at 11 gets represented by whichever file
        # was read first, and the reported price is arbitrary.
        return (s["handle_exact"], s["name_exact"],
                -(s["usd_per_1k"] if s["usd_per_1k"] is not None else 9e9))

    best = {}
    for s in scores:
        cur = best.get(s["model"])
        if cur is None or rank(s) > rank(cur):
            best[s["model"]] = s
    return list(best.values())


def nationality_quality(s, cons):
    """How much the model actually says on the field that has no key.

    Accuracy is not available here, so the measurable thing is nerve: a model
    that answers "American" for all 99 scores well against a mostly-American
    consensus while carrying no information at all. `calls` counts the
    non-default answers it was willing to make, and `missed_firm` counts the
    origins the panel is confident about that this model flattened -- which is
    the number that separates a cautious model from an incurious one.
    """
    calls = missed = matched = 0
    for n, c in cons.items():
        got = s["nationality"].get(n, "")
        if got and got not in ("american", "unknown"):
            calls += 1
        if got == c["nationality"]:
            matched += 1
        elif c["agreement"] >= 0.8 and c["nationality"] not in ("american", "unknown"):
            missed += 1
    return {"nat_calls": calls, "nat_matched": matched, "nat_missed_firm": missed}


def consensus_nationality(scores, roster):
    """Majority vote per entry across models, plus how split the vote was.

    Only counts models that read the entry's handle correctly at that position:
    a nationality attached to a misread name is a guess about a different name.
    """
    votes = defaultdict(Counter)
    for s in best_per_model(scores):
        for n, nat in s["nationality"].items():
            if nat and nat not in ("unknown", "n/a", "none"):
                votes[n][nat] += 1
    out = []
    for r in roster:
        c = votes.get(r["n"], Counter())
        total = sum(c.values())
        top, cnt = (c.most_common(1)[0] if c else ("unknown", 0))
        out.append({"n": r["n"], "display_name": r["display_name"],
                    "handle": r["handle"], "nationality": top,
                    "agreement": round(cnt / total, 2) if total else 0.0,
                    "votes": total, "alternatives": dict(c.most_common(4))})
    return out


def main(argv):
    roster = sheet.roster()
    files = [RESULTS / a for a in argv] if argv else run_files()
    if not files:
        raise SystemExit("no results/sheet_*.json -- run run_sheet.py first")

    scores = []
    for f in files:
        run = json.loads(f.read_text(encoding="utf-8"))
        scores.append(score_run(run, roster))

    scores.sort(key=lambda s: (-s["handle_exact"], -s["name_exact"], s["seconds"] or 9e9))

    print(f"\n{len(scores)} runs over {sheet.N_ENTRIES} entries "
          f"(display name compared emoji-stripped)\n")
    print(f"{'model':<30}{'mode':>6}{'sec':>7}{'in tok':>8}{'out tok':>8}"
          f"{'$/1k':>9}{'got':>5}{'handle':>9}{'char':>7}{'name':>8}{'char':>7}{'emoji':>7}")
    print("-" * 111)
    for s in scores:
        mode = f"r{s['rows_per_call']}" + (f"x{s['scale']}" if s['scale'] != 1 else "")
        usd = f"{s['usd_per_1k']:.3f}" if s["usd_per_1k"] is not None else "n/a"
        print(f"{s['model']:<30}{mode:>6}{s['seconds'] or 0:>7.1f}"
              f"{s['prompt_tokens'] or 0:>8}{s['completion_tokens'] or 0:>8}"
              f"{usd:>9}{s['emitted']:>5}"
              f"{s['handle_exact']:>6}/99{s['handle_char_acc']:>6.1f}%"
              f"{s['name_exact']:>5}/99{s['name_char_acc']:>6.1f}%"
              f"{s['name_emoji_exact']:>4}/99")

    print(f"\n{'model':<30}{'anywhere':>10}{'misplaced':>11}{'invented':>10}"
          f"{'blank':>7}{'dup n':>7}{'trunc':>7}{'err':>5}")
    print("-" * 87)
    for s in scores:
        print(f"{s['model']:<30}{s['handle_found_anywhere']:>7}/99"
              f"{s['handle_misplaced']:>11}{s['handle_invented']:>10}"
              f"{s['handle_blank']:>7}{s['duplicate_n']:>7}"
              f"{s['truncated']:>7}{s['errors']:>5}")

    good = [s for s in scores if s["handle_exact"] >= 60]
    if good:
        cons = consensus_nationality(good, roster)
        firm = sum(1 for c in cons if c["agreement"] >= 0.8 and c["votes"] >= 3)
        split = [c for c in cons if 0 < c["agreement"] < 0.6]
        print(f"\nnationality (inference, no key): "
              f"{len(best_per_model(good))} models voting, "
              f"{firm}/99 entries at >=80% agreement, {len(split)} genuinely split")
        for c in split[:12]:
            print(f"  {c['n']:>3} {c['display_name'][:22]:<24}{c['handle'][:18]:<20}"
                  f"{c['alternatives']}")
        out = RESULTS / "nationality_consensus.json"
        out.write_text(json.dumps(cons, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"  -> {out}")

        # The nationality column, ranked. Cost is per 1000 profiles, so this is
        # the table to read when deciding what to actually run.
        by_n = {c["n"]: c for c in cons}
        print(f"\n{'model':<30}{'mode':>6}{'$/1k':>9}{'handles':>9}"
              f"{'origin calls':>14}{'firm missed':>13}")
        print("-" * 81)
        rank = []
        for s in best_per_model(good):
            rank.append((s, nationality_quality(s, by_n)))
        rank.sort(key=lambda r: (-r[1]["nat_calls"], r[1]["nat_missed_firm"]))
        for s, q in rank:
            mode = f"r{s['rows_per_call']}"
            usd = f"{s['usd_per_1k']:.3f}" if s["usd_per_1k"] is not None else "n/a"
            print(f"{s['model']:<30}{mode:>6}{usd:>9}{s['handle_exact']:>6}/99"
                  f"{q['nat_calls']:>14}{q['nat_missed_firm']:>13}")

    summary = RESULTS / "sheet_scores.json"
    summary.write_text(json.dumps(
        [{k: v for k, v in s.items() if k not in ("nationality", "mistakes")}
         | {"nat_conf": dict(s["nat_conf"])} for s in scores],
        indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n-> {summary}")
    return scores


if __name__ == "__main__":
    main(sys.argv[1:])
