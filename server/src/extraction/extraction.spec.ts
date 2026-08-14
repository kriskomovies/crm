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
  countryMatches,
  emojiKey,
  isPlausibleHandle,
  NO_NATIONALITY,
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

  it('flags a genuine conflict, which the filter drops on', () => {
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
  /**
   * This is the load-bearing assertion under the whole sentinel design, not a
   * spelling test.
   *
   * `NO_NATIONALITY` is the value a rule names to target people whose
   * nationality was never read, and it is safe ONLY because normCountry -- the
   * single writer of Person.nationality -- maps that exact string to null
   * before storage. So no person can hold it and the sentinel cannot shadow a
   * real reading. The day someone drops 'none' from this line, the sentinel
   * silently starts meaning "people the model literally answered 'none' for"
   * as well, and the two populations become impossible to tell apart.
   */
  it('never stores the sentinel, which is what makes it usable as one', () => {
    expect(normCountry(NO_NATIONALITY)).toBeNull();
    expect(normCountry('none')).toBeNull();
    expect(normCountry('NONE')).toBeNull();
    // The other three that null, for the same reason: each is a non-answer.
    expect(normCountry('unknown')).toBeNull();
    expect(normCountry('n/a')).toBeNull();
    expect(normCountry('')).toBeNull();
    // And what a real answer does: lowercased and trimmed, not vetted against
    // any list. This is why the rules screen cannot carry a closed vocabulary.
    expect(normCountry('  Italian ')).toBe('italian');
    expect(normCountry('Welsh')).toBe('welsh');
    // Punctuation survives, which is why '(none)' would NOT have been a safe
    // sentinel -- a model answering it stores it verbatim.
    expect(normCountry('(none)')).toBe('(none)');
  });

  it('ranks confidence floors', () => {
    expect(confidenceAtLeast('high', 'medium')).toBe(true);
    expect(confidenceAtLeast('low', 'medium')).toBe(false);
    expect(confidenceAtLeast(undefined, 'low')).toBe(false);
  });
});

/**
 * The country predicate, which is the one part of PipelineService.filter that
 * can be asked questions without a database.
 *
 * All four cases below were live bugs or live near-misses on `kris agency`:
 * welsh was unreachable because it was not in a constant, the 112 people with
 * no reading were unreachable by construction, and the empty list is what every
 * "forward everything" rule in the suite is spelled as.
 */
describe('countryMatches', () => {
  it('treats an empty list as any, including the people with no reading', () => {
    expect(countryMatches([], 'welsh')).toBe(true);
    expect(countryMatches([], null)).toBe(true);
  });

  it('matches a value the model returned that no constant ever listed', () => {
    // 19 people in production. Before this, no checkbox could reach them and
    // submitting the value silently saved a rule without it.
    expect(countryMatches(['welsh'], 'welsh')).toBe(true);
    expect(countryMatches(['welsh'], 'english')).toBe(false);
    expect(countryMatches(['hebrew', 'japanese'], 'japanese')).toBe(true);
  });

  it('folds case in both directions', () => {
    // The rule is typed one way and the model answers another. An exact
    // includes() matched nothing and looked exactly like an untriggered filter.
    expect(countryMatches(['English'], 'english')).toBe(true);
    expect(countryMatches(['english'], 'English')).toBe(true);
    expect(countryMatches([' Italian '], 'italian')).toBe(true);
  });

  it('matches exactly the unread bucket when the rule names the sentinel', () => {
    expect(countryMatches([NO_NATIONALITY], null)).toBe(true);
    expect(countryMatches([NO_NATIONALITY], undefined)).toBe(true);
    // And nobody else. A person WITH a reading is not unread however weak the
    // reading was -- that is what minConfidence is for.
    expect(countryMatches([NO_NATIONALITY], 'english')).toBe(false);
    expect(countryMatches([NO_NATIONALITY], 'welsh')).toBe(false);
  });

  /**
   * The deploy guard, named for the rule it protects.
   *
   * 'unknown' was a member of the deleted ORIGINS constant: the Targeting
   * screen rendered it as a chip, the old PUT accepted it, and it matched
   * NOBODY because the filter demanded a non-null nationality first. So a
   * client can be sitting on `countries: ['English', 'unknown']` right now.
   * Had the sentinel been spelled 'unknown', that rule would have started
   * forwarding the entire unread bucket on the deploy that fixed the filter --
   * 112 people against 572 on `kris agency` -- with nobody touching the screen.
   * It must go on matching nobody.
   */
  it('leaves a legacy `unknown` tick matching nobody, as it always did', () => {
    expect(countryMatches(['unknown'], null)).toBe(false);
    expect(countryMatches(['unknown'], 'english')).toBe(false);
    expect(countryMatches(['English', 'unknown'], null)).toBe(false);
    // And the half of that rule that DID work still works, unchanged.
    expect(countryMatches(['English', 'unknown'], 'english')).toBe(true);
  });

  it('composes the sentinel with real countries in one rule', () => {
    // The operator ticks `english` and `no nationality read`. Both populations
    // forward; a third does not. The sentinel is one more member of the same
    // OR, which is why it cannot collide with "any" -- that is a property of
    // the array's length, not of its contents.
    const rule = ['english', NO_NATIONALITY];
    expect(countryMatches(rule, 'english')).toBe(true);
    expect(countryMatches(rule, null)).toBe(true);
    expect(countryMatches(rule, 'welsh')).toBe(false);
  });

  it('does not let a named country leak the unread bucket in', () => {
    // The bug in the other direction: if the sentinel were implemented as "no
    // reading matches anything", naming `english` alone would forward all 112.
    expect(countryMatches(['english'], null)).toBe(false);
  });

  /**
   * Adding a country to a rule can only ever ADD people. The empty list is the
   * top of that lattice, so it must match everything every non-empty list
   * matches -- including the unread bucket, which `['none']` names explicitly.
   *
   * Asserted as a relation rather than as five separate cases because the
   * failure it caught was exactly a broken relation: the first version of the
   * confidence gate made `[]` a strict SUBSET of `['none']` (see
   * pipeline.service.ts), so ticking one more box widened the result past
   * "any" while the PUT note went on calling the empty list "every origin".
   * countryMatches never had that bug; the gate downstream of it did, and this
   * pins the half that has to stay true for the fix to mean anything.
   */
  it('makes the empty list a superset of every list, unread bucket included', () => {
    const populations = [null, undefined, 'english', 'welsh', 'italian'];
    for (const lists of [['english'], ['welsh', NO_NATIONALITY], [NO_NATIONALITY]]) {
      for (const p of populations) {
        if (countryMatches(lists, p)) expect(countryMatches([], p)).toBe(true);
      }
    }
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
