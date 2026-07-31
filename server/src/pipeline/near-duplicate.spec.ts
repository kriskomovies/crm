/**
 * The near-duplicate guard.
 *
 * Exists because two independent extractions of the same image produced
 * `timetgotawatch` and `timetogotawatch` for one person. Exact-match dedupe let
 * both into the ledger; had they matched the client's filter, two accounts
 * would have been told to follow the same man.
 */
import { describe, expect, it } from 'vitest';

import { editDistanceAtMost1 } from './pipeline.service';

describe('editDistanceAtMost1', () => {
  it('catches the real misread that caused the leak', () => {
    // sheet 1 dropped an "o" that sheet 2 read correctly
    expect(editDistanceAtMost1('timetgotawatch', 'timetogotawatch')).toBe(true);
  });

  it('catches substitutions, insertions and deletions', () => {
    expect(editDistanceAtMost1('kadenm_o6', 'kadenm_06')).toBe(true); // o -> 0
    expect(editDistanceAtMost1('towmaterrrrrrr', 'towmaterrrrrrrr')).toBe(true);
    expect(editDistanceAtMost1('sclarkson', 'sclarckson')).toBe(true);
    expect(editDistanceAtMost1('abc', 'abc')).toBe(true);
  });

  it('rejects anything further apart than one edit', () => {
    expect(editDistanceAtMost1('austingar_23', 'charless0.8')).toBe(false);
    expect(editDistanceAtMost1('kevinabruno', 'kevinsbruno2')).toBe(false);
    expect(editDistanceAtMost1('abc', 'abcde')).toBe(false);
    // two substitutions
    expect(editDistanceAtMost1('scoobeyjew', 'scoobyjeu')).toBe(false);
  });

  it('does not treat a transposition as one edit', () => {
    // "hehjwy20" vs "hejhwy20" is two substitutions, not one, and the two could
    // genuinely be different accounts -- so it must not merge silently.
    expect(editDistanceAtMost1('hehjwy20', 'hejhwy20')).toBe(false);
  });
});
