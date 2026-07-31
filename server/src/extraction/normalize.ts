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

/** True when avatar and name each state a sex and they conflict -> review. */
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
