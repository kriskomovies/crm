"""The live production prompt, read out of the server's TypeScript.

sheet_task.py is a port, and ports drift: this one still tells the model to
answer "American" for generic anglophone names and still asks for `bald`, both
of which the server stopped doing. A bake-off run against it measures a prompt
nobody ships, which is worse than no measurement because it looks like one.

So the text is lifted from server/src/extraction/sheet-task.ts at run time.
Extracting a template literal with a regex is ugly, and it is still the right
trade: the alternative is a third copy of the prompt that also drifts, and this
one fails loudly -- a rename or a reflow of that file raises here instead of
quietly benchmarking a stale string.
"""
import pathlib
import re

TS = (pathlib.Path(__file__).resolve().parents[1]
      / "server" / "src" / "extraction" / "sheet-task.ts")

_NOTE = re.compile(r"export const READ_ORDER_NOTE = `([\s\S]*?)`;")
_FN = re.compile(r"export function sheetPrompt\([^)]*\)\s*:\s*string\s*\{\s*"
                 r"return `([\s\S]*?)`;\s*\}")


def sheet_prompt(n, cols=3):
    src = TS.read_text(encoding="utf-8")
    note = _NOTE.search(src)
    body = _FN.search(src)
    if not note or not body:
        raise RuntimeError(f"cannot find the prompt in {TS}; it was refactored")
    return (body.group(1)
            .replace("${READ_ORDER_NOTE}", note.group(1))
            .replace("${n}", str(n))
            .replace("${cols}", str(cols)))


# What the production prompt returns, and how to compare it. Transcription is
# handled separately by the handle table; these are the judgement fields.
FIELDS = [("nationality", "nationality"),
          ("nationality_confidence", "nat. confidence"),
          ("avatar_presents_as", "avatar presents"),
          ("name_presents_as", "name presents"),
          ("skin_tone", "skin tone")]


if __name__ == "__main__":
    print(sheet_prompt(33, 2))
