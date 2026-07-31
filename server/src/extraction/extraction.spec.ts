/**
 * Tests for the logic ported from vlm_eval/.
 *
 * Every case here corresponds to a real failure that cost time to find in the
 * Python version. They exist so the port cannot quietly reintroduce them:
 *
 *  - the gateway streams even when not asked to, so a JSON-body parse yields
 *    nothing for every model at once
 *  - usage totals only arrive in the final chunk, after finish_reason
 *  - long replies truncate mid-array and must be salvaged, not discarded
 *  - NFKC has to run before emoji stripping or stylised names vanish entirely
 *  - a male-coded display name must not override a feminine avatar
 */
import { describe, expect, it } from 'vitest';

import {
  distinctCuesRatio,
  entriesFrom,
  extractJson,
} from './sheet-task';
import {
  cleanDisplayName,
  combinePresents,
  confidenceAtLeast,
  emojiKey,
  isPlausibleHandle,
  normCountry,
  normHandle,
  signalsDisagree,
  stripEmoji,
  toPresents,
} from './normalize';

const ENTRY =
  '{"n":1,"display_name":"Austin","handle":"austingar_23","nationality":"American"}';

describe('extractJson', () => {
  it('parses a clean object', () => {
    const r = extractJson(`{"entries":[${ENTRY}]}`);
    expect(r.entries).toHaveLength(1);
    expect(r.salvaged).toBe(false);
    expect(r.entries[0].handle).toBe('austingar_23');
  });

  it('digs the object out of a markdown fence and surrounding chatter', () => {
    const r = extractJson(
      'Sure! Here you go:\n```json\n{"entries":[' + ENTRY + ']}\n```\nHope that helps.',
    );
    expect(r.entries).toHaveLength(1);
  });

  it('salvages complete objects from a reply truncated mid-array', () => {
    // The realistic 99-entry failure: the model runs out of tokens partway.
    const truncated = `{"entries":[${ENTRY},${ENTRY},{"n":3,"display_name":"Ster`;
    const r = extractJson(truncated);
    expect(r.salvaged).toBe(true);
    expect(r.entries).toHaveLength(2);
  });

  it('accepts a bare array and alternate wrapper keys', () => {
    expect(extractJson(`[${ENTRY}]`).entries).toHaveLength(1);
    expect(extractJson(`{"rows":[${ENTRY}]}`).entries).toHaveLength(1);
  });

  it('returns nothing rather than throwing on a refusal', () => {
    expect(extractJson('I cannot help with that.').entries).toHaveLength(0);
    expect(extractJson('').entries).toHaveLength(0);
  });

  it('ignores non-object array members', () => {
    expect(entriesFrom({ entries: [ENTRY, null, 42, JSON.parse(ENTRY)] })).toHaveLength(1);
  });
});

describe('normHandle — the dedupe key', () => {
  it('casefolds, trims and drops a leading @', () => {
    expect(normHandle('  @Kris_Snap01 ')).toBe('kris_snap01');
    expect(normHandle('KADENM_O6')).toBe('kadenm_o6');
  });

  it('treats the same handle from two accounts as one person', () => {
    expect(normHandle('@Austingar_23')).toBe(normHandle('austingar_23 '));
  });

  it('keeps o and 0 distinct — they are different accounts', () => {
    // The single hardest glyph pair in this font; conflating them would merge
    // two real people into one ledger row.
    expect(normHandle('kadenm_o6')).not.toBe(normHandle('kadenm_06'));
  });

  it('rejects transcription noise that is not a valid handle', () => {
    expect(isPlausibleHandle('austingar_23')).toBe(true);
    expect(isPlausibleHandle('jmartinez-2705')).toBe(true);
    expect(isPlausibleHandle('ab')).toBe(false); // too short
    expect(isPlausibleHandle('9lives')).toBe(false); // must start with a letter
    expect(isPlausibleHandle('has spaces')).toBe(false);
  });
});

describe('display-name normalisation', () => {
  it('folds stylised capitals instead of deleting them', () => {
    // U+1F133 and friends are inside the pictographic block. Strip before NFKC
    // and the whole name disappears; the Python version had to learn this.
    const boxed = '\u{1F133}\u{1F148}\u{1F13B}\u{1F130}\u{1F13D}';
    expect(stripEmoji(boxed)).toBe('DYLAN');
  });

  it('removes true emoji but keeps the words', () => {
    expect(stripEmoji('Kurt Bey🦊🇹🇷')).toBe('Kurt Bey');
    expect(stripEmoji('💯Tyrone💯😈')).toBe('Tyrone');
  });

  it('drops unrenderable boxes from the emoji key', () => {
    // The capture could not draw these; the model is told to omit them, so
    // scoring them would punish it for following instructions.
    expect(emojiKey('ryan ▯')).toBe('');
    expect(emojiKey('Tj�')).toBe('');
  });

  it('collapses whitespace and caps length', () => {
    expect(cleanDisplayName('  Sam   Clarckson ')).toBe('Sam Clarckson');
    expect(cleanDisplayName('x'.repeat(500))).toHaveLength(200);
  });
});

describe('presents_as combination', () => {
  it('lets the avatar override a male-coded name', () => {
    // charlie_gafa: feminine cartoon, male-reading name. The combined judgement
    // forwarded her to a men-only feed; this is the rule that stops that.
    expect(combinePresents(toPresents('woman'), toPresents('man'))).toBe('woman');
  });

  it('falls back to the name only when the cartoon says nothing', () => {
    expect(combinePresents(toPresents('ambiguous'), toPresents('man'))).toBe('man');
    expect(combinePresents(toPresents(''), toPresents(''))).toBe('ambiguous');
  });

  it('keeps not-a-person out of the man bucket', () => {
    expect(combinePresents(toPresents('not-a-person'), toPresents('man'))).toBe(
      'not-a-person',
    );
  });

  it('flags a genuine conflict for review', () => {
    expect(signalsDisagree('man', 'woman')).toBe(true);
    expect(signalsDisagree('woman', 'man')).toBe(true);
    expect(signalsDisagree('man', 'ambiguous')).toBe(false);
    expect(signalsDisagree('unknown', 'man')).toBe(false);
  });

  it('normalises the spellings models actually emit', () => {
    expect(toPresents('Man')).toBe('man');
    expect(toPresents('female')).toBe('woman');
    expect(toPresents('not a person')).toBe('not-a-person');
    expect(toPresents('who knows')).toBe('unknown');
  });
});

describe('country and confidence', () => {
  it('treats unknown as absent so it can never match a target list', () => {
    expect(normCountry('unknown')).toBeNull();
    expect(normCountry('  Italian ')).toBe('italian');
  });

  it('ranks confidence floors', () => {
    expect(confidenceAtLeast('high', 'medium')).toBe(true);
    expect(confidenceAtLeast('low', 'medium')).toBe(false);
    expect(confidenceAtLeast(undefined, 'low')).toBe(false);
  });
});

describe('distinctCuesRatio — the fabrication guard', () => {
  it('is high when the model described each face separately', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ cues: `face ${i}` }));
    expect(distinctCuesRatio(entries)).toBe(1);
  });

  it('collapses when the model emits one template for every face', () => {
    // gpt-4.1-mini wrote the same sentence for 94 of 99 different avatars while
    // labelling everything "man" — invisible without this check.
    const entries = Array.from({ length: 99 }, (_, i) => ({
      cues: i < 94 ? 'short hair, no lashes, thin lips' : `other ${i}`,
    }));
    expect(distinctCuesRatio(entries)!).toBeLessThan(0.25);
  });

  it('is null when no cues were requested', () => {
    expect(distinctCuesRatio([{ handle: 'x' }])).toBeNull();
  });
});
