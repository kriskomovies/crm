/**
 * Whether a claim may fall back to the onboarding pool.
 *
 * The switch belongs to the AGENT -- whether an account needs seeding is a fact
 * about the device, a fresh install versus one that has run for a month, and
 * the agent is the side that can see it. From here a new account and an
 * established one whose roster is merely empty today look identical.
 *
 * What is asserted below is the direction the parsing fails in. This value
 * rides on the one GET every machine in the fleet makes, so the two ways to get
 * it wrong are not equally bad: seeding when it need not have costs a handful
 * of searched adds, while refusing to seed on an unreadable value strands a
 * brand-new account that has no other way to start. So anything not recognised
 * as "off" is ON, and a malformed value is not a 400 either -- a typo in one
 * machine's config must not turn into an account that claims nothing at all.
 */
import { describe, expect, it } from 'vitest';

import { mayOnboard } from './targets.controller';

describe('mayOnboard defaults to on', () => {
  it('says yes when the parameter is absent', () => {
    // Every agent built before the flag existed sends nothing, and must keep
    // the behaviour it has always had.
    expect(mayOnboard(undefined)).toBe(true);
    expect(mayOnboard('')).toBe(true);
  });

  it('says yes for a value nobody recognises', () => {
    // The safe direction: a brand-new account with no roster has no other way
    // to start, so an unreadable value must not be what stops it.
    expect(mayOnboard('yes-please')).toBe(true);
    expect(mayOnboard('null')).toBe(true);
    expect(mayOnboard('2')).toBe(true);
  });
});

describe('mayOnboard turns off only when told plainly', () => {
  it('accepts every spelling of off an agent might send', () => {
    for (const off of ['0', 'false', 'no', 'off']) {
      expect(mayOnboard(off), off).toBe(false);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    // A hand-edited config or a shell that keeps a trailing space must not
    // silently re-enable seeding on a box that asked for it off.
    expect(mayOnboard('FALSE')).toBe(false);
    expect(mayOnboard('Off')).toBe(false);
    expect(mayOnboard(' 0 ')).toBe(false);
  });

  it('does not read `true` as off', () => {
    expect(mayOnboard('true')).toBe(true);
    expect(mayOnboard('1')).toBe(true);
    expect(mayOnboard('on')).toBe(true);
  });
});
