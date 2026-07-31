"""Score the FORWARD/HOLD decision, not the fields it is made from.

The service forwards a profile when it presents as a man AND its name reads as
one of a client's target countries. Field-level accuracy does not tell you
whether that decision is right, and on this dataset it actively misleads:

    87 of 99 profiles are "man", so a model that answers "man" for every
    single row scores 88% -- indistinguishable from a working model by any
    overall-accuracy number.

So the headline here is **minority-class recall**: of the 12 profiles that are
NOT men, how many did the model correctly decline to call a man? That is the
number that decides whether the filter does anything, and a constant scores 0.

What is and is not truly scored:

  presents_as   scored against `gender_presentation` in ground_truth.json, which
                was keyed from the pixels. This is a real measurement.
  nationality   has no key and cannot have one. Scored against the 16-model
                consensus in results/nationality_consensus.json, which is a
                reference, not a truth. Reported separately and labelled.
  forward       the combined decision, against a reference decision built from
                the real gender key and the consensus country.

    python route_eval.py --countries italian,turkish,indian,german
    python route_eval.py --run sheet_gemini-3.6-flash_r33_gender.json
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import sheet
from score_sheet import RESULTS, norm_handle

GT = Path(__file__).resolve().parent / "ground_truth.json"
CONSENSUS = RESULTS / "nationality_consensus.json"
CONF_RANK = {"high": 3, "medium": 2, "low": 1, "": 0}

# Anything not a confident single person is not a "man" for routing purposes.
NOT_MAN = {"woman", "ambiguous", "not-a-person"}


def gender_key():
    """{handle: gender_presentation} from the pixel-keyed ground truth."""
    gt = json.loads(GT.read_text(encoding="utf-8"))
    out = {}
    for page in sorted(gt["pages"]):
        for r in gt["pages"][page]:
            h = norm_handle(r["handle"])
            if h not in out:
                out[h] = (r.get("gender_presentation") or "").strip().casefold()
    return out


def country_reference():
    if not CONSENSUS.exists():
        raise SystemExit("run score_sheet.py first to build the consensus")
    return {norm_handle(c["handle"]): (c["nationality"], c["agreement"])
            for c in json.loads(CONSENSUS.read_text(encoding="utf-8"))}


def load_run(name):
    p = Path(name) if Path(name).exists() else RESULTS / name
    run = json.loads(p.read_text(encoding="utf-8"))
    by_handle = {}
    for e in run["entries"]:
        h = norm_handle(e.get("handle"))
        if h:
            by_handle[h] = e
    return run, by_handle


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="sheet_gemini-3.6-flash_r33_gender.json")
    ap.add_argument("--countries", default="italian,turkish,indian,german,french",
                    help="comma-separated target set for the forward rule")
    ap.add_argument("--min-conf", default="medium",
                    choices=["low", "medium", "high"],
                    help="minimum confidence on BOTH inferences to forward")
    a = ap.parse_args(argv)
    targets = {c.strip().casefold() for c in a.countries.split(",") if c.strip()}
    floor = CONF_RANK[a.min_conf]

    gkey = gender_key()
    cref = country_reference()
    run, got = load_run(a.run)
    roster = sheet.roster()

    print(f"run       {run['model']}  ({len(run.get('calls', []))} call(s))")
    print(f"rule      presents_as = man AND country in {sorted(targets)} "
          f"AND both confidences >= {a.min_conf}\n")

    # ---- part 1: gender, truly scored -------------------------------------
    def field(r, name):
        return str(got.get(norm_handle(r["handle"]), {})
                   .get(name, "")).strip().casefold()

    def pred_of(r):
        """What the profile presents as, once the two signals are combined.

        The avatar wins, because it is the signal the ground truth actually
        grades and the one a name cannot override. The name only breaks a tie
        when the cartoon is genuinely unreadable. Runs from before the fields
        were split fall back to the old combined field.
        """
        av, nm = field(r, "avatar_presents_as"), field(r, "name_presents_as")
        if not av and not nm:
            return field(r, "presents_as")
        if av in ("man", "woman"):
            return av
        if av == "not-a-person":
            return "not-a-person"
        return nm or "ambiguous"

    def disagree(r):
        av, nm = field(r, "avatar_presents_as"), field(r, "name_presents_as")
        return av in ("man", "woman") and nm in ("man", "woman") and av != nm

    def truth_of(r):
        return gkey.get(norm_handle(r["handle"]), "")

    conf = Counter()
    missing = 0
    for r in roster:
        if norm_handle(r["handle"]) not in got:
            missing += 1
            continue
        conf[(truth_of(r) or "(blank)", pred_of(r) or "(blank)")] += 1
    truths = sorted({t for t, _ in conf})
    preds = sorted({p for _, p in conf})
    print("avatar_presents_as vs the pixel-keyed gender_presentation")
    print(f"  {'key \\ model':<16}" + "".join(f"{p[:12]:>14}" for p in preds))
    for t in truths:
        print(f"  {t:<16}" + "".join(f"{conf.get((t, p), 0):>14}" for p in preds))

    men = [r for r in roster if truth_of(r) == "man"]
    women = [r for r in roster if truth_of(r) == "woman"]
    # "ambiguous" is reported apart from the hard errors on purpose. The key
    # grades `gender_presentation` -- the CARTOON only -- while the prompt asks
    # for `presents_as`, the cartoon AND the name together. A row whose avatar is
    # unreadable but whose name is plainly male is legitimately "man" under the
    # prompt and "ambiguous" under the key. Scoring those as mistakes would be
    # measuring the definition gap, not the model.
    other = [r for r in roster if truth_of(r) in ("ambiguous", "not-a-person")]

    # "Held" means the router would not forward it, which a disagreement between
    # the two signals achieves just as well as a "woman" label -- the profile
    # goes to review either way. Counting only the label would score the split
    # prompt as worse than the combined one while it is in fact catching more.
    def would_forward(r):
        return pred_of(r) == "man" and not disagree(r)

    men_ok = sum(1 for r in men if would_forward(r))
    women_held = sum(1 for r in women if not would_forward(r))
    other_held = sum(1 for r in other if not would_forward(r))

    print(f"\n  men still forwarded             {men_ok}/{len(men)}")
    print(f"  WOMEN held back from forward     {women_held}/{len(women)}"
          f"   <-- the number that matters")
    print(f"  ambiguous/not-a-person held      {other_held}/{len(other)}"
          f"   (definition gap, see source)")
    print(f"  a constant \"man\" scores          {len(men)}/{len(men)}, "
          f"0/{len(women)}, 0/{len(other)}")
    hard = [r for r in women if would_forward(r)]
    if hard:
        print("  WOMEN that would still be forwarded (hard errors):")
        for r in hard:
            print(f"    {r['n']:>3} {r['display_name'][:24]:<26}{r['handle'][:18]:<20}"
                  f"avatar={field(r, 'avatar_presents_as')} "
                  f"name={field(r, 'name_presents_as')}")
    soft = [r for r in other if would_forward(r)]
    if soft:
        print("  ambiguous forwarded (defensible -- name reads male):")
        for r in soft:
            print(f"    {r['n']:>3} {r['display_name'][:24]:<26}{r['handle']}")
    conflicts = [r for r in roster if disagree(r)]
    if conflicts:
        print(f"\n  avatar and name disagree on {len(conflicts)} profiles "
              f"-> these must go to review, never straight to forward:")
        for r in conflicts:
            print(f"    {r['n']:>3} {r['display_name'][:22]:<24}{r['handle'][:18]:<20}"
                  f"avatar={field(r, 'avatar_presents_as'):<10}"
                  f"name={field(r, 'name_presents_as'):<10}key={truth_of(r)}")

    if len(women) < 30:
        print(f"\n  !! {len(women)} women in the whole set. Any rate computed on "
              f"that is worth +-20 points;")
        print(f"     this cannot certify the filter, only catch a broken one.")

    # ---- part 2: the forward decision -------------------------------------
    def confident(e, field):
        return CONF_RANK.get(str(e.get(f"{field}_confidence", "")).strip().casefold(), 0) >= floor

    # Three buckets, not two. A profile the 18-model panel could not agree on
    # (agreement < 0.6) is UNDECIDED, not a negative: counting it as a false
    # positive when the model picks the panel's own plurality would be scoring
    # the model against a reference that has no opinion.
    fwd_pred, fwd_ref, undecided = set(), set(), set()
    for r in roster:
        h = norm_handle(r["handle"])
        e = got.get(h, {})
        nat = str(e.get("nationality", "")).strip().casefold()
        # Forward needs the avatar to say man AND the name not to contradict it.
        # A contradiction is a review item, not a negative and not a forward.
        if (pred_of(r) == "man" and not disagree(r) and nat in targets
                and confident(e, "nationality")):
            fwd_pred.add(h)
        ref_nat, ref_agree = cref.get(h, ("", 0))
        if gkey.get(h) != "man":
            continue
        if ref_nat in targets and ref_agree >= 0.6:
            fwd_ref.add(h)
        elif ref_nat in targets:
            undecided.add(h)          # panel's plurality is a target, but split

    hit = fwd_pred & fwd_ref
    wrong = fwd_pred - fwd_ref - undecided
    split = fwd_pred & undecided
    prec = len(hit) / len(fwd_pred - undecided) if (fwd_pred - undecided) else 0.0
    rec = len(hit) / len(fwd_ref) if fwd_ref else 0.0
    print(f"\nforward decision")
    print(f"  reference forwards       {len(fwd_ref)}/99   "
          f"(+{len(undecided)} the panel could not agree on)")
    print(f"  model forwards           {len(fwd_pred)}/99")
    print(f"  precision {prec:.0%}   recall {rec:.0%}   "
          f"(excluding the undecided)")
    for h in sorted(split):
        e = got[h]
        c = cref.get(h, ("-", 0))
        print(f"    UNDECIDED      {h:<18} model={e.get('nationality')}  "
              f"panel plurality={c[0]} at {c[1]:.0%} agreement")
    for h in sorted(wrong):
        e = got[h]
        print(f"    FALSE POSITIVE {h:<18} model={e.get('nationality')}/"
              f"{e.get('presents_as')}  ref={cref.get(h, ('-',))[0]}/{gkey.get(h)}")
    for h in sorted(fwd_ref - fwd_pred):
        e = got.get(h, {})
        print(f"    MISSED         {h:<18} model={e.get('nationality')}/"
              f"{e.get('presents_as')}  ref={cref.get(h, ('-',))[0]}/{gkey.get(h)}")
    if missing:
        print(f"\n  {missing} roster handles absent from the run")


if __name__ == "__main__":
    main(sys.argv[1:])
