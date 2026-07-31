"""The prompt for the contact sheet, and the JSON extractor for the reply.

Four fields per entry, and they are not the same kind of thing:

  display_name  transcription. One right answer, checkable against the pixels.
  handle        transcription. Same.
  nationality   an INFERENCE from the name, not a fact in the image. Nothing in
                a screenshot can confirm what nationality someone is, so this is
                only ever "what origin does this name read as", and it is graded
                as agreement between models rather than as correctness. The
                prompt says so explicitly, because a model told to state a
                person's nationality from a username will happily do it with
                false confidence; told to name the origin of the name, it gives
                a calibrated answer and uses "unknown" when the handle is just
                digits.
  avatar_presents_as   how the drawn Bitmoji reads, judged with the name hidden.
  name_presents_as     how the display name reads, judged with the cartoon hidden.

The last two are asked SEPARATELY, and that is the whole point. Asked for one
combined judgement, gemini-3.6-flash forwarded 2 of the 5 women in the corpus as
men -- including `charlie_gafa`, whose avatar has long hair, eye makeup and
lipstick, because the name "Charlie" reads male in English and the name won.
Split apart, the disagreement is visible and routing can hold the profile for
review instead of forwarding a woman to a client who asked for men.

Neither is a claim about the person behind the account: one describes a cartoon
they chose, the other a name they typed. `ground_truth.json` grades the cartoon
under `gender_presentation`, so `avatar_presents_as` is the field that can
actually be scored. See route_eval.py, which scores the forward/hold decision
rather than the fields.
"""
import json
import re

PROMPT = """\
This image is a contact sheet of {n} entries from a Snapchat friend-suggestion \
list, laid out as a grid {cols} columns wide.

READING ORDER IS CRITICAL: go left to right across each row of the grid, then \
down to the next row. Entry 1 is top-left, entry 2 is the middle of the top \
row, entry 3 is top-right, entry 4 is the left of the second row, and so on. \
Number them {first} to {last} in that order.

Each entry is a round cartoon avatar, a display name in black, and a grey \
username handle directly under the name.

Return ONLY a JSON object, no prose and no markdown fence:
{{"entries": [{{"n": {first}, "display_name": "...", "handle": "...", \
"nationality": "...", "nationality_confidence": "...", \
"avatar_presents_as": "...", "name_presents_as": "..."}}, ...]}}

Emit exactly {n} entries, numbered {first} to {last}, none skipped.

Rules:
- display_name: copy the black text EXACTLY as rendered, character for \
character. Do not correct spelling and do not normalise an unusual surname to \
its common form. Include every emoji that appears, in order. If a glyph renders \
as an unsupported-character box, omit it.
- handle: the grey lowercase text directly under the name. Copy it exactly, \
including dots, underscores, hyphens and digits.
- nationality: the nationality or country of origin that the NAME most suggests \
-- this is a guess about the name's linguistic origin, not a claim about the \
person. Give one nationality as an adjective, e.g. "American", "Turkish", \
"Italian", "German", "Indian". Most of this list reads as generic \
English-language names: use "American" for those. Use "unknown" when the entry \
is only initials, digits or a nickname with nothing to go on.
- nationality_confidence: "high", "medium" or "low". Use "low" freely -- a \
first name alone is weak evidence.
- avatar_presents_as: judge ONLY the drawn cartoon, ignoring the name \
completely. One of "man", "woman", "ambiguous", "not-a-person". Look at hair \
length, eye makeup, lipstick, earrings, jewellery, facial hair and clothing. \
"not-a-person" if the avatar is not a human figure or is a blank silhouette. \
Do not let the display name influence this field at all -- a feminine cartoon \
is "woman" even when the name reads male.
- name_presents_as: judge ONLY the display name, ignoring the cartoon \
completely. One of "man", "woman", "ambiguous". Use "ambiguous" for unisex \
names, initials, nicknames and handles with nothing to go on -- it is the \
correct answer far more often than either alternative, so use it freely.
These two are deliberately separate and MUST be judged independently. Do not \
reconcile them; if the cartoon and the name disagree, report the disagreement.
- If you genuinely cannot read a name or handle, use "" rather than inventing \
one."""


PROMPT_LIST = """\
This image is a screenshot of the Snapchat "Quick Add" friend-suggestion list, \
containing {n} entries stacked vertically in a single column.

Each entry is a round cartoon avatar on the left, a display name in black, and a \
grey username handle directly under the name.

Number them 1 to {n} from the top down.

Return ONLY a JSON object, no prose and no markdown fence:
{{"entries": [{{"n": 1, "display_name": "...", "handle": "...", \
"nationality": "...", "nationality_confidence": "..."}}, ...]}}

Emit exactly {n} entries, numbered 1 to {n}, none skipped.

{rules}"""

# The per-field rules are identical for both layouts; only the framing above
# differs, so they are sliced out of the grid prompt rather than duplicated --
# a second copy would drift and quietly make the two modes incomparable.
_RULES = PROMPT[PROMPT.index("Rules:"):]


def prompt(n, first, last, cols=3):
    return PROMPT.format(n=n, first=first, last=last, cols=cols)


def list_prompt(n):
    """One vertical column of n entries, as in a raw ../pages screenshot."""
    return PROMPT_LIST.format(n=n, rules=_RULES)


def extract_json(text):
    """Pull the first JSON object out of a reply. None when there isn't one --
    format compliance is part of what is being measured, so a mangled reply is
    recorded as a failure rather than crashing the run."""
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        text = fence.group(1)
    start = text.find("{")
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    break
    # Truncated output is common on long lists: salvage the complete objects.
    objs = []
    for m in re.finditer(r"\{[^{}]*\}", text[start:]):
        try:
            objs.append(json.loads(m.group(0)))
        except json.JSONDecodeError:
            pass
    return {"entries": objs, "_salvaged": True} if objs else None


def entries_from(parsed):
    """Accept {"entries":[...]}, {"rows":[...]}, or a bare list."""
    if parsed is None:
        return []
    if isinstance(parsed, list):
        items = parsed
    elif isinstance(parsed, dict):
        items = None
        for k in ("entries", "rows", "data", "results"):
            if isinstance(parsed.get(k), list):
                items = parsed[k]
                break
        if items is None:
            items = [parsed] if "handle" in parsed else []
    else:
        return []
    return [i for i in items if isinstance(i, dict)]
