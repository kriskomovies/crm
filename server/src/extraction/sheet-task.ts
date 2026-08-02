/**
 * The extraction prompt, and the reply parser.
 *
 * Ported from vlm_eval/sheet_task.py. The field set is deliberate and measured
 * (vlm_eval/ROUTING.md):
 *
 *   display_name / handle   transcription. One right answer, checkable.
 *   nationality             an INFERENCE from the name. There is no key for it
 *                           and there cannot be; it is scored as agreement
 *                           between models, never as correctness.
 *   avatar_presents_as      judged from the cartoon with the name hidden.
 *   name_presents_as        judged from the name with the cartoon hidden.
 *
 * The last two are asked SEPARATELY on purpose. Asked as one combined
 * judgement, the model forwarded a woman whose avatar has long hair, eye makeup
 * and lipstick, because her display name reads male in English. Split, the
 * disagreement is visible and the profile can be held for review instead of
 * being sent to a client who asked for men.
 *
 * Neither inference is a claim about a person: one describes a cartoon they
 * chose, the other a name they typed.
 */

export const READ_ORDER_NOTE = `READING ORDER IS CRITICAL: go left to right across each row of the grid, then down to the next row. Entry 1 is top-left, entry 2 is the middle of the top row, entry 3 is top-right, entry 4 is the left of the second row, and so on.`;

export function sheetPrompt(n: number, cols = 3): string {
  return `This image is a contact sheet of ${n} entries from a Snapchat friend-suggestion list, laid out as a grid ${cols} columns wide.

${READ_ORDER_NOTE} Number them 1 to ${n} in that order.

Each entry is a round cartoon avatar, a display name in black, and a grey username handle directly under the name.

Return ONLY a JSON object, no prose and no markdown fence:
{"entries": [{"n": 1, "display_name": "...", "handle": "...", "nationality": "...", "nationality_confidence": "...", "avatar_presents_as": "...", "name_presents_as": "..."}, ...]}

Emit exactly ${n} entries, numbered 1 to ${n}, none skipped.

Rules:
- display_name: copy the black text EXACTLY as rendered, character for character. Do not correct spelling and do not normalise an unusual surname to its common form. Include every emoji that appears, in order. If a glyph renders as an unsupported-character box, omit it.
- handle: the grey lowercase text directly under the name. Copy it exactly, including dots, underscores, hyphens and digits.
- nationality: the origin the NAME suggests -- a guess about the name's linguistic origin, not a claim about the person. One adjective, e.g. "Turkish", "Italian", "Indian". Use "English" for any name that simply reads as a generic English-language name: do NOT split those into American, British, Canadian or Australian, because nothing in such a name distinguishes them and guessing there produces noise. Use "unknown" when the entry is only initials, digits or a nickname.
- nationality_confidence: "high", "medium" or "low". Use "low" freely -- a first name alone is weak evidence.
- avatar_presents_as: judge ONLY the drawn cartoon, ignoring the name completely. One of "man", "woman", "ambiguous", "not-a-person". Read eyelashes, lip colour and eyebrow shape FIRST; hair length is unreliable in this art style. "not-a-person" if the avatar is not a human figure or is a blank silhouette. A feminine cartoon is "woman" even when the name reads male.
- name_presents_as: judge ONLY the display name, ignoring the cartoon completely. One of "man", "woman", "ambiguous". Use "ambiguous" for unisex names, initials and nicknames -- it is correct far more often than either alternative.
These two MUST be judged independently. Do not reconcile them; if the cartoon and the name disagree, report the disagreement.
- If you genuinely cannot read a name or handle, use "" rather than inventing one.`;
}

/**
 * The avatar-only pass. Opt-in per client: +$0.29/1000 profiles, and it halves
 * the women in the "man" bucket (2.1% -> 1.1%).
 *
 * `cues` is not decoration. It is the guard that catches a model which has
 * stopped looking: gpt-4.1-mini emitted the SAME sentence for 94 of 99
 * different faces while labelling everything "man", which against an 88%-male
 * corpus scores 86/87 on men and looks like success. See distinctCuesRatio.
 */
export function avatarPrompt(n: number, cols: number): string {
  return `This image is a grid of ${n} cartoon avatars, ${cols} columns wide, cropped from a social-media friend list.

${READ_ORDER_NOTE} Number them 1 to ${n}.

For each one, describe how the CARTOON is drawn. These are drawings people chose for themselves, so this is a question about a picture, not a claim about anybody.

Return ONLY a JSON object, no prose and no markdown fence:
{"entries": [{"n": 1, "cues": "...", "presents_as": "..."}, ...]}

Emit exactly ${n} entries.

Rules:
- cues: FIRST, in 3-8 words, write what you actually see on this face: hair length and style, whether upper EYELASHES are drawn, whether the lips are full or coloured, eyebrow thickness, earrings, any facial hair, the neckline. Describe before deciding.
- presents_as: THEN one of "man", "woman", "ambiguous", "not-a-person".

How this cartoon style encodes it -- read in this order:
1. EYELASHES are the strongest signal: visible upper lashes read female.
2. LIPS: fuller or coloured reads female; thin and uncoloured reads male.
3. EYEBROWS: thin and arched reads female; thick and straight reads male.
4. Facial hair is decisive for male.
5. HAIR LENGTH IS UNRELIABLE -- short bobs and pixie cuts are common on female avatars. Weigh it last, never first.
Do not assume a default and do not let the overall list bias you. If the cues genuinely conflict, answer "ambiguous".`;
}

export interface RawEntry {
  n?: number;
  display_name?: string;
  handle?: string;
  nationality?: string;
  nationality_confidence?: string;
  avatar_presents_as?: string;
  name_presents_as?: string;
  presents_as?: string;
  cues?: string;
}

/**
 * Pull the first JSON object out of a chatty reply.
 *
 * Walks to the matching brace so trailing commentary does not break the parse,
 * and -- the part that matters in production -- falls back to scraping complete
 * `{...}` objects when the reply was cut off mid-array. A 99-entry answer that
 * truncates at entry 80 still yields 80 usable rows instead of nothing.
 */
export function extractJson(text: string): { entries: RawEntry[]; salvaged: boolean } {
  if (!text) return { entries: [], salvaged: false };

  let body = text;
  const fence = /```(?:json)?\s*([\s\S]+?)```/.exec(body);
  if (fence) body = fence[1];

  const start = body.indexOf('{');
  if (start < 0) return { entries: [], salvaged: false };

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return { entries: entriesFrom(JSON.parse(body.slice(start, i + 1))), salvaged: false };
        } catch {
          break; // fall through to salvage
        }
      }
    }
  }

  // Truncated or malformed: keep whatever complete objects exist.
  const objects: RawEntry[] = [];
  for (const m of body.slice(start).matchAll(/\{[^{}]*\}/g)) {
    try {
      objects.push(JSON.parse(m[0]));
    } catch {
      /* skip */
    }
  }
  return { entries: objects, salvaged: objects.length > 0 };
}

/** Accept {entries}, {rows}, {data}, {results}, or a bare array. */
export function entriesFrom(parsed: unknown): RawEntry[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.filter(isObj);
  if (typeof parsed !== 'object') return [];
  const o = parsed as Record<string, unknown>;
  for (const key of ['entries', 'rows', 'data', 'results']) {
    if (Array.isArray(o[key])) return (o[key] as unknown[]).filter(isObj);
  }
  return 'handle' in o ? [o as RawEntry] : [];
}

function isObj(v: unknown): v is RawEntry {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Share of avatar descriptions that are distinct. Below ~0.25 the model is
 * filling in a template rather than reading pixels and the whole extraction
 * should be rejected -- see avatarPrompt.
 */
export function distinctCuesRatio(entries: RawEntry[]): number | null {
  const cues = entries
    .map((e) => (e.cues ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (cues.length === 0) return null;
  return new Set(cues).size / cues.length;
}
