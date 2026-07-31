"""What we ask the model, and how we pull an answer back out of its reply.

Two tasks, split because they score completely differently:

  read    Transcribe the display name and @handle. Objectively checkable against
          the pixels -- there is exactly one right answer per field. This is the
          task that actually matters for this repo, since it is the job
          ../read_usernames.py currently does with Tesseract.

  avatar  Describe the drawn Bitmoji: facial hair, headwear, eyewear, hair
          colour, skin tone of the cartoon, and whether the cartoon reads as a
          man or a woman. Note the framing -- these are questions about a
          drawing the account holder chose, not about the person behind it. A
          Bitmoji's skin tone is a customisation setting, so "was the model
          right about the avatar" is answerable while "was the model right about
          the human" is not, and we only score the former.

Both prompts demand bare JSON. Models ignore that constantly, so extract_json
digs an object out of ```fences``` and surrounding chatter -- how often it has to
is itself reported as format_failures.
"""
import json
import re

FIELDS_READ = ["display_name", "handle"]
FIELDS_AVATAR = ["facial_hair", "headwear", "eyewear", "hair_color", "skin_tone", "gender_presentation"]

_HEAD = """\
Use exactly the keys shown above, all of them, spelled exactly that way. Do not
merge two keys into one and do not invent extra keys.

Rules:"""

# One rule per field, emitted only when that field is actually requested. A
# text-only crop has no avatar in it, so describing facial hair and skin tone
# there just invites the model to answer questions about pixels it cannot see.
_RULES = {
    "display_name": """\
- Copy text EXACTLY as rendered, character for character, including the spaces
  between words. Do not correct spelling and do not normalise an unusual
  surname to its common form.
- Include every emoji that appears in the display name, in order.""",
    "handle": """\
- The handle is the grey lowercase text directly under the name.""",
    "facial_hair": """\
- facial_hair: one of none, stubble, moustache, goatee, beard, beard+moustache.
  Write "none" explicitly for a clean-shaven face. Never leave it empty.""",
    "headwear": """\
- headwear: "none", or the hat/cap/crown/hood worn on the head.""",
    "eyewear": """\
- eyewear: "none", or the glasses/sunglasses/goggles or anything covering the
  eyes. headwear and eyewear are SEPARATE keys. Never merge them into one key.""",
    "hair_color": """\
- hair_color: the colour of the hair on the head (black, brown, light brown,
  blond, red, grey, white). If a hat covers all of it, say "not visible".""",
    "skin_tone": """\
- skin_tone: the face colour of the cartoon, one of pale, light, light-tan,
  medium-tan, tan, brown, dark-brown. Do NOT let hair, hat or shirt colour sway
  this. Almost every avatar here is a normal drawn face, so pick one of those
  seven. Only two special answers exist, and both are rare:
  "placeholder" -- ONLY if there is no face at all, just a flat single-colour
  person-shaped silhouette. If you can see eyes, pick a real tone instead.
  "stylised" -- ONLY if the whole avatar is one flat unnatural colour.""",
    "gender_presentation": """\
- gender_presentation: how the cartoon is drawn -- man, woman, ambiguous, or
  not-a-person. This is about the drawing only.""",
}

_TAIL = """\
- If you genuinely cannot read a name or handle, use "" rather than inventing
  one. Every other key must always have a value."""


def _rules_for(fields):
    return "\n".join([_HEAD] + [_RULES[f] for f in fields if f in _RULES] + [_TAIL])

PROMPT_PAGE = """\
This is a screenshot of the Snapchat "Quick Add" friend-suggestion list.
It contains {n} rows. Each row has a round cartoon Bitmoji avatar on the left, a
display name, a grey username handle under the name, and an "Add" button.

Return ONLY a JSON object, no prose and no markdown fence:
{{"rows": [{{"position": 1, {fields}}}, ...]}}

position is 1-based from the top. Emit exactly {n} rows.

{rules}"""

PROMPT_ROW = """\
This is ONE row cropped from the Snapchat "Quick Add" list: a round cartoon
Bitmoji avatar on the left, a display name to its right, and a grey username
handle directly under the display name.

Return ONLY a JSON object, no prose and no markdown fence:
{{{fields}}}

{rules}"""

PROMPT_BAND = """\
This is a strip cropped from the Snapchat "Quick Add" list containing {n}
entries stacked vertically. Each entry is a display name with a grey username
handle directly underneath it.

Return ONLY a JSON object, no prose and no markdown fence:
{{"rows": [{{"position": 1, {fields}}}, ...]}}

position is 1-based from the top of this strip. Emit exactly {n} rows.

{rules}"""


def _field_stubs(fields):
    return ", ".join(f'"{f}": "..."' for f in fields)


def fields_for(task):
    if task == "read":
        return list(FIELDS_READ)
    if task == "avatar":
        return list(FIELDS_AVATAR)
    if task == "both":
        return FIELDS_READ + FIELDS_AVATAR
    raise SystemExit(f"unknown task {task!r} (want read, avatar, or both)")


def page_prompt(task, n_rows):
    f = fields_for(task)
    return PROMPT_PAGE.format(n=n_rows, fields=_field_stubs(f), rules=_rules_for(f))


def row_prompt(task):
    f = fields_for(task)
    return PROMPT_ROW.format(fields=_field_stubs(f), rules=_rules_for(f))


def band_prompt(task, n_rows):
    f = fields_for(task)
    if n_rows == 1:
        return row_prompt(task)
    return PROMPT_BAND.format(n=n_rows, fields=_field_stubs(f), rules=_rules_for(f))


def extract_json(text):
    """Pull the first JSON object out of a model reply. Returns None if there
    isn't one -- the caller counts that as a format failure rather than crashing,
    because format compliance is part of what we are grading."""
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        text = fence.group(1)
    start = text.find("{")
    if start < 0:
        return None
    # Walk to the matching brace so trailing commentary does not break the parse.
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
                    return None
    return None
