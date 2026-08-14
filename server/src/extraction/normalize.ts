/**
 * Normalisation rules, ported from vlm_eval/score.py and score_sheet.py.
 *
 * `normHandle` is the dedupe key -- it decides whether two of a personality's
 * accounts have found the same person -- so it is deliberately the simplest
 * thing that works and is covered by tests. The display-name rules are subtler
 * and one of them is load-bearing in a way that is easy to undo:
 *
 *   NFKC MUST run BEFORE stripping emoji. Stylised display names such as
 *   "\u{1F133}\u{1F148}\u{1F13B}\u{1F130}\u{1F13D}" (a boxed-capital DYLAN) sit
 *   inside the pictographic block, so stripping first deletes the entire name.
 *   NFKC folds them to plain ASCII first; flag regional indicators have no
 *   decomposition and survive to be stripped as the emoji they are.
 */

const PRESENTS = ['man', 'woman', 'ambiguous', 'not-a-person'] as const;
export type PresentsValue = (typeof PRESENTS)[number] | 'unknown';

/** The dedupe key. Casefolded, trimmed, leading @ removed. */
export function normHandle(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/^@+/, '');
}

/**
 * Snapchat handles are 3-15 chars, start with a letter, then letters, digits,
 * dot, underscore or hyphen. Used to reject transcription noise before it
 * reaches the ledger -- an invented handle that looks plausible is far more
 * damaging here than a dropped one, because nothing downstream can detect it.
 */
const HANDLE_RE = /^[a-z][a-z0-9._-]{2,14}$/;

export function isPlausibleHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

function isEmojiCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) || // skin-tone modifiers
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    cp === 0x200d || // ZWJ
    cp === 0xfe0f || // variation selector
    cp === 0x20e3 || // keycap
    cp === 0xfffd // replacement char
  );
}

/** Display-name text with emoji removed. NFKC first -- see the file header. */
export function stripEmoji(raw: string | null | undefined): string {
  const s = (raw ?? '').normalize('NFKC');
  let out = '';
  for (const ch of s) {
    if (!isEmojiCodePoint(ch.codePointAt(0)!)) out += ch;
  }
  return out.split(/\s+/).filter(Boolean).join(' ');
}

/** Glyphs the capture could not render. Never scored, never stored as emoji. */
const TOFU = new Set(['�', '▯', '□', '■', '⬜', '⬛']);

export function emojiKey(raw: string | null | undefined): string {
  const s = (raw ?? '').normalize('NFKC');
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isEmojiCodePoint(cp) && cp !== 0x200d && cp !== 0xfe0f && !TOFU.has(ch)) {
      out += ch;
    }
  }
  return out;
}

/** Tidy a display name for storage: keep emoji, collapse whitespace. */
export function cleanDisplayName(raw: string | null | undefined): string {
  return (raw ?? '').normalize('NFKC').split(/\s+/).filter(Boolean).join(' ').slice(0, 200);
}

/** Map a free-text model answer onto the enum, defaulting to unknown. */
export function toPresents(raw: string | null | undefined): PresentsValue {
  const v = (raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (v === 'man' || v === 'male') return 'man';
  if (v === 'woman' || v === 'female') return 'woman';
  if (v === 'not-a-person' || v === 'notaperson' || v === 'none') return 'not-a-person';
  if (v === 'ambiguous' || v === 'unisex' || v === 'unclear') return 'ambiguous';
  return 'unknown';
}

/** Prisma enums cannot contain hyphens; the DB spells it not_a_person. */
export function presentsToDb(v: PresentsValue): string {
  return v === 'not-a-person' ? 'not_a_person' : v;
}

export function normCountry(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'n/a' || v === 'none' || v === 'unknown') return null;
  return v.slice(0, 40);
}

/**
 * The country a rule names to target people whose nationality was never read.
 *
 * Two properties make a string usable here, and the obvious candidate --
 * 'unknown', which is what this shipped as until review -- has only the first.
 *
 * 1. NO PERSON CAN HOLD IT. `normCountry` above is the only writer of
 *    Person.nationality, and it maps '', 'n/a', 'none' and 'unknown' to null
 *    before storage, so any of those four is safe from shadowing a real
 *    reading. Nothing else is: normCountry lowercases and truncates but does
 *    not strip punctuation, so a model answering "(none)" stores `(none)`
 *    verbatim, and `__none__` would store likewise. Exactly four strings are
 *    un-storable, and extraction.spec.ts guards the mapping by name.
 *
 * 2. NO ALREADY-SAVED RULE CAN HOLD IT. This one is about the deploy, not the
 *    data, and it is what rules out 'unknown'. 'unknown' was a member of the
 *    ORIGINS constant that used to live in rules.controller.ts: the Targeting
 *    screen rendered it as a chip and the old PUT accepted it, so a client can
 *    have had it ticked for months. All that time it matched NOBODY, because
 *    the filter required a non-null nationality before it compared anything.
 *    Reusing that same string as the sentinel would have flipped every such
 *    rule from forwarding nobody to forwarding the whole unread bucket on the
 *    deploy that fixed it, with no operator touching the screen -- on `kris
 *    agency` that is 112 people against 572 english, a ~20% jump in queue
 *    volume against a fixed dailyCapPerAccount, on a population nobody opted
 *    into. 'none' was never in ORIGINS, so the old PUT dropped it and no screen
 *    ever offered it; a rule that still holds the legacy 'unknown' goes on
 *    matching nobody, and now says so out loud -- /api/rules reports it as an
 *    option with a count of 0 and the screen marks it `none now`.
 *
 * It does not collide with "any" either: "any" is `countries.length === 0`, a
 * property of the array. The sentinel is a MEMBER of the array. The two live in
 * different places and compose freely.
 *
 * Measured on production (`kris agency`): 112 people had no nationality read --
 * the second-largest bucket -- and NO rule could reach them.
 */
export const NO_NATIONALITY = 'none';

/**
 * Does this person's nationality satisfy a rule's country list?
 *
 * Pure, and separated from PipelineService.filter so the three cases that used
 * to be provable only against Postgres -- empty means any, the sentinel matches
 * exactly the unread, a sentinel beside real countries matches both -- are unit
 * testable.
 *
 * Case-insensitive, and it has to be. The model answers "Italian" while a rule
 * is typed "italian", and an exact includes() silently matched NOTHING -- a
 * filter that forwards nobody looks identical to a filter nobody has triggered
 * yet, so it can run for days before anyone asks why the queue is empty.
 * Measured on the 99-profile golden sheet: 17 men matched with case folding, 0
 * without.
 */
export function countryMatches(
  countries: readonly string[],
  nationality: string | null | undefined,
): boolean {
  // Empty = any, including the people with no reading at all. Unchanged, and it
  // must stay unchanged: every e2e client's permissive baseline is spelled this
  // way, and repurposing the empty list for the sentinel would silently narrow
  // every rule that means "everyone".
  if (countries.length === 0) return true;
  const wanted = countries.map((c) => c.trim().toLowerCase());
  if (!nationality) return wanted.includes(NO_NATIONALITY);
  return wanted.includes(nationality.trim().toLowerCase());
}

/**
 * The closed skin-tone vocabulary. The first seven form an ordinal scale from
 * pale to dark-brown; the last three are off-scale -- `placeholder` for a
 * faceless silhouette, `stylised` for a flat unnatural colour, and `unreadable`
 * for anything the model could not judge. Ported from vlm_eval/score.py, which
 * is the harness that measured these values against apimart's replies.
 */
export const SKIN_TONES = [
  'pale',
  'light',
  'light-tan',
  'medium-tan',
  'tan',
  'brown',
  'dark-brown',
  'placeholder',
  'stylised',
  'unreadable',
] as const;

export type SkinTone = (typeof SKIN_TONES)[number];

/**
 * The phrasings apimart reaches for that mean one of the canonical tones. Keys
 * are already hyphenated (spaces folded to `-`) so a single lookup covers both
 * "light skin" and "light-skin". Kept in step with vlm_eval/score.py SYNONYMS.
 */
const SKIN_ALIASES: Record<string, SkinTone> = {
  'light-skin': 'light',
  fair: 'light',
  'light-blond': 'light',
  'pale-skin': 'pale',
  medium: 'medium-tan',
  olive: 'light-tan',
  'light-olive': 'light-tan',
  'light-golden': 'light-tan',
  tanned: 'tan',
  silhouette: 'placeholder',
  stylized: 'stylised',
};

/**
 * Map a free-text tone answer onto the closed set. Returns null when the reply
 * is empty or unrecognised -- we never fabricate a tone, and an empty rule
 * treats a null tone as "any" anyway.
 */
export function normSkinTone(raw: string | null | undefined): SkinTone | null {
  const v = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/\.+$/, '');
  if (!v) return null;
  const mapped = SKIN_ALIASES[v] ?? v;
  return (SKIN_TONES as readonly string[]).includes(mapped)
    ? (mapped as SkinTone)
    : null;
}

const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function confidenceAtLeast(
  value: string | null | undefined,
  floor: string,
): boolean {
  return (
    (CONF_RANK[(value ?? '').trim().toLowerCase()] ?? 0) >=
    (CONF_RANK[floor.toLowerCase()] ?? 0)
  );
}

/**
 * How the profile presents once both signals are in.
 *
 * The avatar wins. It is the signal ground truth actually grades, and it is the
 * one a display name must not be able to override -- that override is exactly
 * how a woman named "Charlie" ends up in a client's men-only feed.
 */
export function combinePresents(
  avatar: PresentsValue,
  name: PresentsValue,
): PresentsValue {
  if (avatar === 'man' || avatar === 'woman' || avatar === 'not-a-person') {
    return avatar;
  }
  return name === 'unknown' ? 'ambiguous' : name;
}

/** True when avatar and name each state a sex and they conflict -> dropped. */
export function signalsDisagree(
  avatar: PresentsValue,
  name: PresentsValue,
): boolean {
  return (
    (avatar === 'man' || avatar === 'woman') &&
    (name === 'man' || name === 'woman') &&
    avatar !== name
  );
}
