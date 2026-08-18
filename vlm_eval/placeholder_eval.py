"""What a placeholder fall-through would do to a men-only feed. No model calls.

Production refuses a person outright when the avatar reads `not-a-person`:
combinePresents (normalize.ts:178) returns the avatar whenever it is man, woman
or not-a-person, so a default coloured silhouette with a display name that reads
`man` is dropped and the name never gets a vote. The proposal is to let it vote
in exactly one case -- avatar `not-a-person` AND skin tone `placeholder`, the
value the schema documents as "a faceless silhouette" (normalize.ts:107-118) --
on the argument that those are real men the capture simply did not draw.

The number that decides the change is not how many men come back. It is how many
women come with them, and that is what this scores, against the keyed 99.

Everything here is a port of the server, not a paraphrase of it:

  toPresents / normSkinTone / combinePresents / signalsDisagree  normalize.ts
  presentsToDb + fromDb round trip                    pipeline.service.ts:227,465
  forwarded = not signalsDisagree, then presentsAs matches the rule
                                                      pipeline.service.ts:374-378

`self_check()` re-asserts the cases extraction.spec.ts asserts, so a port that
drifts from the server fails loudly here rather than quietly reporting a number.

A men-only feed is modelled as one rule, presentsAs=['man'], no country, tone or
confidence predicate. A real rule may carry those too; they only ever shrink both
columns, and they are identical either side of the change, so the delta is
unaffected. The near-duplicate drop (pipeline.service.ts:369) is likewise held
constant -- it is a fact about the ledger, not about this reading.

Entries are aligned by HANDLE, as golden_eval.py does and for the same reason: a
numbering slip must not be scored as a gender bug.
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
R = HERE / "results"

# The two live candidates. Both files are the LIVE production prompt over the
# keyed 99 (golden_eval.py) and are the most recent stored reply for each model
# that carries both avatar_presents_as and skin_tone -- the proposed rule reads
# both, so a run missing either cannot be scored on it at all.
RUNS = {
    "gemini-3-flash-preview-nothinking":
        "golden_gemini-3-flash-preview-nothinking.json",
    "gemini-3.6-flash": "golden_gemini-3.6-flash.json",
}

TRUTHS = ["man", "woman", "ambiguous", "not-a-person"]


# ---------------------------------------------------------------- normalize.ts

def to_presents(raw):
    """normalize.ts:80. Free text -> the enum, defaulting to unknown."""
    v = " ".join((raw or "").strip().lower().split())
    v = v.replace(" ", "-").replace("_", "-")
    if v in ("man", "male"):
        return "man"
    if v in ("woman", "female"):
        return "woman"
    if v in ("not-a-person", "notaperson", "none"):
        return "not-a-person"
    if v in ("ambiguous", "unisex", "unclear"):
        return "ambiguous"
    return "unknown"


SKIN_TONES = ["pale", "light", "light-tan", "medium-tan", "tan", "brown",
              "dark-brown", "placeholder", "stylised", "unreadable"]

SKIN_ALIASES = {"light-skin": "light", "fair": "light", "light-blond": "light",
                "pale-skin": "pale", "medium": "medium-tan",
                "olive": "light-tan", "light-olive": "light-tan",
                "light-golden": "light-tan", "tanned": "tan",
                "silhouette": "placeholder", "stylized": "stylised"}


def norm_skin_tone(raw):
    """normalize.ts:146. Closed set or None; never fabricates a tone."""
    v = " ".join((raw or "").strip().lower().split()).replace(" ", "-")
    v = v.replace("_", "-").rstrip(".")
    if not v:
        return None
    mapped = SKIN_ALIASES.get(v, v)
    return mapped if mapped in SKIN_TONES else None


def combine_presents(avatar, name):
    """normalize.ts:178. The avatar wins outright."""
    if avatar in ("man", "woman", "not-a-person"):
        return avatar
    return "ambiguous" if name == "unknown" else name


def combine_proposed(avatar, name, tone):
    """The change: a silhouette stops being a verdict and becomes a no-read."""
    if avatar == "not-a-person" and tone == "placeholder":
        return "ambiguous" if name == "unknown" else name
    return combine_presents(avatar, name)


def signals_disagree(avatar, name):
    """normalize.ts:189. Only fires when both name a sex and they conflict."""
    return (avatar in ("man", "woman") and name in ("man", "woman")
            and avatar != name)


def presents_to_db(v):
    """normalize.ts:90, and pipeline.service.ts:465 reads it back."""
    return "not_a_person" if v == "not-a-person" else v


def from_db(v):
    return v.replace("_", "-")


def forwarded(presents, avatar, name):
    """pipeline.service.ts:374-378 for a rule of presentsAs=['man']."""
    if signals_disagree(avatar, name):
        return False
    return from_db(presents_to_db(presents)) == "man"


# -------------------------------------------------------------------- the port
# is only worth anything if it still agrees with the server it copies.

def self_check():
    cases = [
        (combine_presents(to_presents("woman"), to_presents("man")), "woman"),
        (combine_presents(to_presents("ambiguous"), to_presents("man")), "man"),
        (combine_presents(to_presents(""), to_presents("")), "ambiguous"),
        (combine_presents(to_presents("not-a-person"), to_presents("man")),
         "not-a-person"),
        (signals_disagree("man", "woman"), True),
        (signals_disagree("woman", "man"), True),
        (signals_disagree("man", "ambiguous"), False),
        (signals_disagree("unknown", "man"), False),
        (to_presents("Man"), "man"),
        (to_presents("female"), "woman"),
        (to_presents("not a person"), "not-a-person"),
        (presents_to_db("not-a-person"), "not_a_person"),
        (norm_skin_tone("silhouette"), "placeholder"),
        (norm_skin_tone("Placeholder"), "placeholder"),
        (norm_skin_tone("beige"), None),
        (norm_skin_tone(None), None),
    ]
    bad = [(i, got, want) for i, (got, want) in enumerate(cases) if got != want]
    for i, got, want in bad:
        print(f"  PORT DISAGREES with extraction.spec.ts, case {i}: "
              f"got {got!r}, want {want!r}")
    print(f"port self-check: {len(cases) - len(bad)}/{len(cases)} "
          f"assertions from extraction.spec.ts")
    return not bad


# ---------------------------------------------------------------------- corpus

def load_gt():
    gt = json.loads((HERE / "ground_truth.json").read_text(encoding="utf-8"))
    out = {}
    for page in sorted(gt["pages"]):
        for r in gt["pages"][page]:
            out.setdefault(r["handle"].strip().lower(), r)
    return out


def truth_of(raw):
    """The key writes plain words; fold them onto the same enum."""
    v = to_presents(raw)
    return v if v in TRUTHS else "unknown"


def main():
    import sheet

    ok = self_check()
    if not ok:
        return 1

    gt = load_gt()
    roster = sheet.roster()
    truth = {r["handle"].strip().lower():
             truth_of(gt.get(r["handle"].strip().lower(), {})
                      .get("gender_presentation")) for r in roster}
    n_truth = {t: sum(1 for v in truth.values() if v == t) for t in TRUTHS}
    print(f"keyed corpus: {len(roster)} entries -- "
          + ", ".join(f"{n_truth[t]} {t}" for t in TRUTHS)
          + f"\n  the gender sample is {n_truth['woman']} women. "
            "Counts only; there are no percentages to be had from 5.\n")

    for model, fname in RUNS.items():
        path = R / fname
        if not path.exists():
            print(f"{model}: {path.name} MISSING -- not scored, not guessed")
            continue
        run = json.loads(path.read_text(encoding="utf-8"))
        by_handle = {(e.get("handle") or "").strip().lower(): e
                     for e in run["entries"]}

        today = {t: 0 for t in TRUTHS}
        prop = {t: 0 for t in TRUTHS}
        unread = 0
        changed = []
        gated = []          # every entry the new branch actually fires on
        for r in roster:
            h = r["handle"].strip().lower()
            t = truth[h]
            e = by_handle.get(h)
            if e is None:
                unread += 1          # never read -> never forwarded, either way
                continue
            av = to_presents(e.get("avatar_presents_as"))
            nm = to_presents(e.get("name_presents_as") or e.get("presents_as"))
            tone = norm_skin_tone(e.get("skin_tone"))
            f_now = forwarded(combine_presents(av, nm), av, nm)
            f_new = forwarded(combine_proposed(av, nm, tone), av, nm)
            today[t] += f_now
            prop[t] += f_new
            if av == "not-a-person" and tone == "placeholder":
                gated.append((h, r["display_name"], t, nm, f_now, f_new))
            if f_now != f_new:
                changed.append((h, r["display_name"], t, nm, f_now, f_new))

        print(f"{'=' * 78}\n{model}\n{'=' * 78}")
        print(f"{'ground truth':<16}{'in key':>8}{'fwd today':>11}"
              f"{'fwd proposed':>14}{'delta':>8}")
        print("-" * 57)
        for t in TRUTHS:
            d = prop[t] - today[t]
            print(f"{t:<16}{n_truth[t]:>8}{today[t]:>11}{prop[t]:>14}"
                  f"{d:>+8}")
        tot_now, tot_new = sum(today.values()), sum(prop.values())
        print(f"{'TOTAL':<16}{len(roster):>8}{tot_now:>11}{tot_new:>14}"
              f"{tot_new - tot_now:>+8}")
        if unread:
            print(f"  ({unread} roster handles absent from this reply)")

        # The rule can only ever act where its gate opens. If nothing is listed
        # here the delta above is structurally zero, not a measured null result
        # about silhouette men.
        print(f"\n  gate fires (avatar=not-a-person AND tone=placeholder): "
              f"{len(gated)}")
        for h, dn, t, nm, a, b in gated:
            print(f"    {h:<20}{(dn or '')[:18]:<20}key={t:<13}name={nm:<10}"
                  f"{'fwd' if a else 'held'} -> {'fwd' if b else 'held'}")

        print(f"\n  verdict changes: {len(changed)}")
        for h, dn, t, nm, a, b in changed:
            recov = "RECOVERED" if b and not a else "newly held"
            good = "man in key" if t == "man" else f"{t} in key"
            print(f"    {h:<20}{(dn or '')[:18]:<20}{recov:<11}{good}")
        rec = [c for c in changed if c[5] and not c[4]]
        if rec:
            print(f"    of {len(rec)} recovered: "
                  + ", ".join(f"{sum(1 for c in rec if c[2] == t)} {t}"
                              for t in TRUTHS
                              if any(c[2] == t for c in rec)))
        print(f"    extra women forwarded: "
              f"{prop['woman'] - today['woman']} (sample: {n_truth['woman']} "
              f"women in the whole key)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
