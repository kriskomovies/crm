"""Which combination of passes actually keeps women out of a men-only feed?

Four configurations, all scored the way the server routes rather than as raw
field accuracy (normalize.ts): the avatar wins outright, and a wrong avatar is
only rescued when the display NAME positively reads female. So the question is
never "what did the model label this face" on its own -- it is what the pair of
signals does to her.

  sheet only          one call, avatar_presents_as taken from the sheet pass
  sheet + avatar      the sheet pass for names and nationality, with
                      avatar_presents_as overridden by the avatar-only pass

The avatar pass exists because a 70px face inside a contact sheet is competing
with 99 lines of text for the model's attention; cropped out and tripled in
size it is a different problem, and it is cheap because it emits no
transcription.

Costs are the measured per-sheet spends divided over 99 entries.
"""
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
R = HERE / "results"
N = 99

# Measured, from golden_eval.py and avatar_eval.py.
SHEET_USD = {"gemini-3-flash-preview-nothinking": 0.0233,
             "gemini-3.6-flash": 0.1282}
AVATAR_USD = {"gemini-3-flash-preview-nothinking": 0.0079,
              "gemini-3.6-flash": 0.0525}
A_MODEL = "gemini-3-flash-preview-nothinking"
B_OTHER = "gemini-3.6-flash"


def presents(s):
    v = (s or "").strip().lower().replace("_", "-")
    return {"male": "man", "female": "woman", "unclear": "ambiguous"}.get(v, v)


def load_gt():
    gt = json.loads((HERE / "ground_truth.json").read_text(encoding="utf-8"))
    out = {}
    for page in sorted(gt["pages"]):
        for r in gt["pages"][page]:
            out.setdefault(r["handle"].strip().lower(), r)
    return out


def fate(av, nm):
    """What the server does with one profile, from normalize.ts."""
    if av in ("man", "woman") and nm in ("man", "woman") and av != nm:
        return "dropped"
    routed = av if av in ("man", "woman", "not-a-person") else (nm or "ambiguous")
    return "forwarded-as-man" if routed == "man" else routed


def main():
    import sheet
    gt = load_gt()
    roster = sheet.roster()
    women = [r for r in roster
             if presents(gt.get(r["handle"].strip().lower(), {})
                         .get("gender_presentation")) == "woman"]
    men = [r for r in roster
           if presents(gt.get(r["handle"].strip().lower(), {})
                       .get("gender_presentation")) == "man"]

    rows = []
    for mid in SHEET_USD:
        slug = mid.replace(".", ".")
        sheet_run = json.loads((R / f"golden_{slug}.json").read_text("utf-8"))
        by_handle = {(e.get("handle") or "").strip().lower(): e
                     for e in sheet_run["entries"]}
        apath = R / f"avatars_{slug}_cues_x3.json"
        av_run = json.loads(apath.read_text("utf-8")) if apath.exists() else None
        av_by_n = {}
        if av_run:
            for i, e in enumerate(av_run["entries"]):
                try:
                    av_by_n[int(e["n"])] = e
                except (KeyError, TypeError, ValueError):
                    av_by_n[i + 1] = e

        # The cross combination is the interesting one. Gender is the only field
        # the cheap model is dangerous on, and the avatar pass is a separate
        # call already -- so there is no reason both passes have to be the same
        # model. Cheap sheet + expensive avatar buys the expensive gender read
        # without paying it on the 99 lines of text it is not better at.
        for mode in ("sheet only", "sheet + avatar", "sheet + OTHER avatar"):
            if "avatar" in mode and not av_run:
                continue
            use_av = av_by_n
            if mode == "sheet + OTHER avatar":
                other = B_OTHER if mid == A_MODEL else A_MODEL
                p = R / f"avatars_{other}_cues_x3.json"
                if not p.exists():
                    continue
                o = json.loads(p.read_text("utf-8"))
                use_av = {}
                for i, e in enumerate(o["entries"]):
                    try:
                        use_av[int(e["n"])] = e
                    except (KeyError, TypeError, ValueError):
                        use_av[i + 1] = e
            leaked, saved, detail = [], 0, []
            for r in women:
                h = r["handle"].strip().lower()
                e = by_handle.get(h, {})
                nm = presents(e.get("name_presents_as"))
                av = presents(e.get("avatar_presents_as"))
                if "avatar" in mode:
                    av = presents(use_av.get(r["n"], {}).get("presents_as")) or av
                f = fate(av, nm)
                detail.append((r["display_name"], av, nm, f))
                if f == "forwarded-as-man":
                    leaked.append(h)
                elif f == "dropped":
                    saved += 1
            # Men wrongly kept out: the cost of a stricter avatar read.
            lost = 0
            for r in men:
                h = r["handle"].strip().lower()
                e = by_handle.get(h, {})
                av = presents(e.get("avatar_presents_as"))
                if "avatar" in mode:
                    av = presents(use_av.get(r["n"], {}).get("presents_as")) or av
                if fate(av, presents(e.get("name_presents_as"))) != "forwarded-as-man":
                    lost += 1
            usd = SHEET_USD[mid]
            if mode == "sheet + avatar":
                usd += AVATAR_USD[mid]
            elif mode == "sheet + OTHER avatar":
                usd += AVATAR_USD[B_OTHER if mid == A_MODEL else A_MODEL]
            rows.append((mid, mode, len(leaked), saved, lost, usd, detail))

    print(f"{'model':<36}{'mode':<16}{'women leaked':>13}{'men lost':>10}"
          f"{'$/1000':>9}")
    print("-" * 84)
    for mid, mode, leaked, saved, lost, usd, _ in rows:
        print(f"{mid:<36}{mode:<16}{f'{leaked}/5':>13}{f'{lost}/87':>10}"
              f"{usd / N * 1000:>8.3f}")

    for mid, mode, leaked, saved, lost, usd, detail in rows:
        print(f"\n{mid}  --  {mode}")
        for dn, av, nm, f in detail:
            flag = "XX" if f == "forwarded-as-man" else "  "
            print(f"  {flag} {dn[:20]:<22}avatar={av:<12}name={nm:<11}{f}")


if __name__ == "__main__":
    main()
