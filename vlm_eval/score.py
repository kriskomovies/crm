"""Score a predictions file from run_eval.py against ground_truth.json.

Text fields (display_name, handle) are graded two ways, because they fail
differently: exact match is what matters if you are going to key on the handle,
while character error rate shows whether a miss was one wrong glyph or complete
fiction. Attribute fields are graded as accuracy over a normalised vocabulary,
so "sunglasses" and "dark sunglasses" both count as sunglasses.

Rows are aligned by handle similarity rather than by position, so a model that
skips a row is charged with a miss instead of silently shifting every later row
into a mismatch.

    python score.py hf_Qwen_Qwen2.5-VL-3B-Instruct_row_both.json
    python score.py a.json b.json          # compare runs side by side
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
GT_PATH = HERE / "ground_truth.json"

TEXT_FIELDS = ["display_name", "handle"]

# display_name is graded twice. Pinning the exact codepoint of an emoji from a
# 20px bitmap is genuinely ambiguous -- a football and a rugby ball render alike
# at that size -- so failing a model for it would measure the wrong thing. The
# headline number is the emoji-stripped text; emoji are reported separately as a
# count of how many the model placed, which is the part that is fairly checkable.
DERIVED_TEXT = "display_name_text"

# Attribute answers we treat as the same thing. Anything not listed is compared
# on its normalised text, so an unexpected-but-correct phrasing still has a
# chance to match rather than being auto-failed.
SYNONYMS = {
    # NOTE: "" is deliberately NOT mapped to "none". A model that returns an
    # empty string has declined to answer, and folding that into "none" hands it
    # a correct mark on every clean-shaven face -- which inflated facial_hair and
    # eyewear badly in page mode, where this model fills the schema with "".
    # "n/a" and friends stay, because those are answers meaning none.
    "n/a": "none", "na": "none", "no": "none", "nothing": "none",
    "clean shaven": "none", "clean-shaven": "none", "no facial hair": "none",
    "mustache": "moustache", "moustache+beard": "beard+moustache",
    "beard and moustache": "beard+moustache", "full beard": "beard",
    "sunglass": "sunglasses", "dark glasses": "sunglasses",
    "eyeglasses": "glasses", "spectacles": "glasses",
    "male": "man", "female": "woman", "m": "man", "f": "woman",
    "light skin": "light", "fair": "light", "pale skin": "pale",
    "medium": "medium-tan", "olive": "light-tan", "light-olive": "light-tan",
    "light-golden": "light-tan", "light-blond": "light", "tanned": "tan",
    "placeholder": "placeholder", "silhouette": "placeholder",
}


def norm_text(s):
    """Casefold, strip accents/emoji-variation-selectors, collapse whitespace.

    NFKC also folds the boxed-capital letters some display names use (the
    'D Y L A N' row is really U+1F133 and friends) down to plain ASCII, so a
    model that writes 'DYLAN' is not marked wrong for it."""
    s = unicodedata.normalize("NFKC", str(s or "")).strip().casefold()
    s = "".join(c for c in s if unicodedata.category(c) != "Mn" and c != "️")
    return " ".join(s.split())


def is_emoji(c):
    """Pictographic characters and the ZWJ/skin-tone modifiers that glue them."""
    o = ord(c)
    return (unicodedata.category(c) == "So"
            or 0x1F000 <= o <= 0x1FAFF
            or 0x1F3FB <= o <= 0x1F3FF          # skin-tone modifiers
            or o in (0x200D, 0xFE0F, 0x20E3))   # ZWJ, variation selector, keycap


def strip_emoji(s):
    """Text of a display name with emoji removed.

    NFKC runs FIRST and that ordering is load-bearing: the boxed-capital letters
    in a name like 🄳🅈🄻🄰🄽 sit at U+1F133 and friends, inside the pictographic
    block and categorised So, so stripping before normalising would delete the
    whole name. NFKC folds them to plain DYLAN first, while flag regional
    indicators have no decomposition and survive to be stripped as emoji."""
    s = unicodedata.normalize("NFKC", str(s or ""))
    return " ".join("".join(c for c in s if not is_emoji(c)).split())


def emoji_of(s):
    """Emoji present, ignoring the invisible joiners, as a multiset-ish string.
    NFKC first for the same reason as strip_emoji -- stylised letters are text."""
    s = unicodedata.normalize("NFKC", str(s or ""))
    return "".join(c for c in s if is_emoji(c) and ord(c) not in (0x200D, 0xFE0F))


# Size/intensity adjectives carry no information we grade on. "thin moustache"
# and "moustache" are the same finding; only presence and kind are scored.
ADJECTIVES = {"thin", "thick", "small", "large", "big", "little", "full", "light",
              "heavy", "short", "long", "slight", "faint", "dark", "tiny", "a",
              "some", "visible", "the"}

_SPLIT = re.compile(r"\s*(?:\+|&|,|/|\band\b|\bwith\b)\s*")


def norm_attr(s):
    """Normalise an attribute answer to a comparable form.

    Compound answers are split, de-adjectived and sorted, so "moustache & small
    goatee" and "goatee + moustache" both land on "goatee+moustache" -- the
    model should not lose a point for word order or for saying "small"."""
    s = norm_text(s).replace("_", "-").rstrip(".")
    if s in SYNONYMS:
        return SYNONYMS[s]
    # Parenthesised asides are commentary, not part of the answer: "none (eyes
    # covered by cucumber slices)" is still "none".
    s = " ".join(re.sub(r"\([^)]*\)", " ", s).split())
    parts = []
    for part in _SPLIT.split(s):
        words = [w for w in part.split() if w not in ADJECTIVES]
        part = SYNONYMS.get(" ".join(words), " ".join(words))
        if part and part != "none":
            parts.append(part)
    if not parts:
        # Empty in, empty out: a blank answer must never normalise to "none".
        return SYNONYMS.get(s, s) if s else ""
    return "+".join(sorted(set(parts)))


# Free-text description fields. Grading these by exact string match measures
# verbosity, not perception: "crown" for a gold crown and "sunglasses" for
# rainbow visor sunglasses are both correct answers that an exact match throws
# away. They are scored by head-noun agreement instead -- the model must name the
# same thing, but need not match the key's adjectives.
DESCRIPTIVE = {"headwear", "eyewear", "hair_color"}

# Skin tone is an ordinal scale, not a set of unrelated labels, and the boundary
# between neighbouring shades is genuinely fuzzy -- two careful human readers
# disagreed on it for 8 of the 99 handles in this corpus. Exact-match alone
# therefore reads as catastrophic failure for a model that is merely one shade
# cooler than the key, so adjacency is reported alongside it. "placeholder" and
# "stylised" are off-scale: they are categorical, and near-misses do not apply.
SKIN_SCALE = ["pale", "light", "light-tan", "medium-tan", "tan", "brown", "dark-brown"]


def skin_distance(truth, got):
    """Buckets apart on the tone scale, or None if either side is off-scale."""
    try:
        return abs(SKIN_SCALE.index(norm_attr(truth)) - SKIN_SCALE.index(norm_attr(got)))
    except ValueError:
        return None

# Words that carry no identifying weight when comparing two descriptions.
FILLER = ADJECTIVES | {"over", "the", "eyes", "on", "worn", "of", "colour",
                       "color", "hair", "a", "an", "and", "or", "style",
                       "styled", "shaped", "coloured", "colored"}


def descriptive_match(truth, got):
    """True when two free-text descriptions name the same thing.

    Either side may be more specific than the other, so this is containment on
    content words rather than equality: key "black cowboy hat" vs model
    "cowboy hat" matches, and so does the reverse. "none" only matches "none",
    so missing a hat entirely is still a miss."""
    a, b = norm_attr(truth), norm_attr(got)
    if a == b:
        return True
    if "none" in (a, b):
        return False              # one saw something, the other saw nothing
    wa = {w for w in re.split(r"[\s/+&,-]+", a) if w and w not in FILLER}
    wb = {w for w in re.split(r"[\s/+&,-]+", b) if w and w not in FILLER}
    if not wa or not wb:
        return False
    return wa <= wb or wb <= wa


def levenshtein(a, b):
    if a == b:
        return 0
    if not a or not b:
        return len(a) or len(b)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def similarity(a, b):
    a, b = norm_text(a), norm_text(b)
    if not a and not b:
        return 1.0
    return 1 - levenshtein(a, b) / max(len(a), len(b), 1)


def align(gt_rows, pred_rows):
    """Greedily pair each ground-truth row with its best unused prediction.

    Handles normally carry the signal -- they are unique, lowercase and immune to
    emoji -- so they dominate the match score. But a prediction set may not
    contain handles at all (the ChatGPT reference table has no handle column), and
    weighting a field nobody supplied would drive every score under threshold and
    report all 14 rows as missing. So the weights follow what is actually present."""
    has_handle = any(str(p.get("handle") or "").strip() for p in pred_rows)
    w_handle = 0.75 if has_handle else 0.0
    w_name = 1.0 - w_handle

    unused = list(pred_rows)
    pairs = []
    for g in gt_rows:
        best, best_s = None, 0.0
        for p in unused:
            s = (w_handle * similarity(g.get("handle"), p.get("handle")) +
                 w_name * similarity(strip_emoji(g.get("display_name")),
                                     strip_emoji(p.get("display_name"))))
            # Position is a weak tiebreak only -- enough to separate two rows
            # that genuinely share a name, never enough to force a wrong pairing.
            if g.get("position") and g.get("position") == p.get("position"):
                s += 0.02
            if s > best_s:
                best, best_s = p, s
        if best is not None and best_s >= 0.35:
            unused.remove(best)
            pairs.append((g, best))
        else:
            pairs.append((g, None))   # model never produced this row
    return pairs, unused              # unused = spurious rows the model invented


def score_file(path, gt):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    fields = data.get("fields", [])
    text_f = [f for f in fields if f in TEXT_FIELDS]
    attr_f = [f for f in fields if f not in TEXT_FIELDS]
    if "display_name" in text_f:
        text_f.insert(text_f.index("display_name"), DERIVED_TEXT)

    graded = fields + ([DERIVED_TEXT] if DERIVED_TEXT in text_f else [])
    tally = {f: {"n": 0, "exact": 0, "err": 0, "chars": 0, "blank": 0} for f in graded}
    emoji = {"rows": 0, "exact": 0}
    skin = {"n": 0, "within1": 0}
    missed = spurious = 0
    calls = fails = 0
    seconds = data.get("total_seconds", 0)
    mistakes = []

    for page, payload in data.get("pages", {}).items():
        gt_rows = gt.get(page)
        if not gt_rows:
            print(f"  ! no ground truth for {page}, skipping")
            continue
        for c in payload.get("calls", []):
            calls += 1
            fails += 0 if c.get("parsed") else 1
        pairs, extra = align(gt_rows, payload.get("rows", []))
        spurious += len(extra)
        for g, p in pairs:
            if p is None:
                missed += 1
                # A row the model never emitted is a total loss on every field,
                # not a silent omission -- charge it the full character count.
                for f in graded:
                    truth = g.get("display_name") if f == DERIVED_TEXT else g.get(f)
                    if truth in (None, ""):
                        continue
                    n = len(norm_text(strip_emoji(truth) if f == DERIVED_TEXT else truth))
                    tally[f]["n"] += 1
                    tally[f]["chars"] += n
                    tally[f]["err"] += n
                if g.get("display_name") and emoji_of(g["display_name"]):
                    emoji["rows"] += 1
                continue

            for f in graded:
                if f == DERIVED_TEXT:
                    truth, got = strip_emoji(g.get("display_name")), strip_emoji(p.get("display_name"))
                else:
                    truth, got = g.get(f), p.get(f, "")
                if truth in (None, ""):
                    continue          # nothing to grade against
                t = tally[f]
                t["n"] += 1
                if not str(got).strip():
                    t["blank"] += 1
                    # This model leaves an attribute blank rather than writing
                    # "none", and only fills it when it sees something. Whether
                    # that counts as a correct "none" or as no answer is a real
                    # judgement call, so both readings are reported: strict
                    # (blank is wrong) and lenient (blank means none). Picking
                    # one silently would swing facial_hair by ~80 points.
                    if f not in text_f and norm_attr(truth) == "none":
                        t["lenient"] = t.get("lenient", 0) + 1
                if f in text_f:
                    a, b = norm_text(truth), norm_text(got)
                    t["chars"] += len(a)
                    t["err"] += levenshtein(a, b)
                    hit = a == b
                elif f in DESCRIPTIVE:
                    hit = descriptive_match(truth, got)
                else:
                    hit = norm_attr(truth) == norm_attr(got)
                    if f == "skin_tone":
                        d = skin_distance(truth, got)
                        if d is not None:
                            skin["n"] += 1
                            skin["within1"] += d <= 1
                if hit:
                    t["exact"] += 1
                elif f != DERIVED_TEXT:   # already reported under display_name
                    mistakes.append((page, g.get("handle", "?"), f, truth, got))

            want = emoji_of(g.get("display_name"))
            if want:
                emoji["rows"] += 1
                emoji["exact"] += emoji_of(p.get("display_name")) == want

    return {"file": Path(path).name, "provider": data.get("provider", "?"),
            "mode": data.get("mode", "?"), "fields": fields,
            "text_fields": text_f, "attr_fields": attr_f,
            "tally": tally, "missed": missed, "spurious": spurious,
            "calls": calls, "format_failures": fails, "seconds": seconds,
            "emoji": emoji, "skin": skin, "mistakes": mistakes}


def report(r, show_mistakes=True):
    print(f"\n{'=' * 66}\n{r['provider']}  [mode={r['mode']}]\n{'=' * 66}")
    if r["calls"]:
        print(f"format compliance : {r['calls'] - r['format_failures']}/{r['calls']} "
              f"replies parsed as JSON")
    # "unmatched" rather than "hallucinated": a prediction with no counterpart in
    # the key is not automatically an invention. The key omits rows clipped by a
    # page edge, and a model that reads one anyway lands here while being right.
    print(f"row coverage      : {r['missed']} missed, "
          f"{r['spurious']} unmatched (check before calling these hallucinations)")
    if r["seconds"]:
        print(f"wall clock        : {r['seconds']}s")

    if r["text_fields"]:
        print(f"\n  {'field':<20}{'exact':>10}{'  char accuracy':>18}")
        for f in r["text_fields"]:
            t = r["tally"][f]
            if not t["n"]:
                continue
            cer = t["err"] / max(t["chars"], 1)
            print(f"  {f:<20}{t['exact']:>4}/{t['n']:<5}{(1 - cer) * 100:>15.1f}%")
        e = r["emoji"]
        if e["rows"]:
            print(f"  {'(emoji in name)':<20}{e['exact']:>4}/{e['rows']:<5}"
                  f"{'':>10}exact codepoints")
    if r["attr_fields"]:
        print(f"\n  {'field':<20}{'correct':>10}{'  accuracy':>18}")
        for f in r["attr_fields"]:
            t = r["tally"][f]
            if not t["n"]:
                continue
            print(f"  {f:<20}{t['exact']:>4}/{t['n']:<5}"
                  f"{t['exact'] / t['n'] * 100:>15.1f}%")
            if t["blank"]:
                lex = t["exact"] + t.get("lenient", 0)
                print(f"  {'  ..blank=none':<20}{lex:>4}/{t['n']:<5}"
                      f"{lex / t['n'] * 100:>15.1f}%   ({t['blank']} blank)")
            if f == "skin_tone" and r["skin"]["n"]:
                s = r["skin"]
                print(f"  {'  ..within 1 shade':<20}{s['within1']:>4}/{s['n']:<5}"
                      f"{s['within1'] / s['n'] * 100:>15.1f}%")

    if show_mistakes and r["mistakes"]:
        print(f"\n  every miss ({len(r['mistakes'])}):")
        for page, handle, f, truth, got in r["mistakes"]:
            print(f"    {page} {handle:<18} {f:<20} want {truth!r:<28} got {got!r}")


def main(argv):
    if not GT_PATH.exists():
        raise SystemExit(f"missing {GT_PATH.name}")
    gt = json.loads(GT_PATH.read_text(encoding="utf-8"))["pages"]
    files = argv or sorted(str(p) for p in RESULTS.glob("*.json"))
    if not files:
        raise SystemExit("no predictions to score -- run run_eval.py first")
    for f in files:
        p = Path(f)
        if not p.exists():
            p = RESULTS / f
        report(score_file(p, gt), show_mistakes=len(files) == 1)


if __name__ == "__main__":
    main(sys.argv[1:])
