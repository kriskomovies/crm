/**
 * The cap day, which is a promise to a human and therefore a timezone question.
 *
 * The bug these pin is not arithmetic. Every `startOfToday` in this codebase was
 * documented as "local midnight -- caps reset by the operator's day, not UTC's",
 * and every one of them was right about that; the CONTAINER had no TZ, so the
 * process was UTC and "local" meant nothing. Measured on 2026-08-17: an account
 * handed 156 people between 02:04 and 02:58 local showed 0/240, because UTC
 * midnight had passed at 03:00 local and taken the evening with it.
 *
 * So these run the same function under two zones. A test that only ever sees the
 * process default would pass on the broken deployment and prove nothing at all.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { startOfToday, utcLiteral } from './day';

const TZ = process.env.TZ;

/**
 * Node re-reads process.env.TZ for subsequent Date work, which is the only way
 * to exercise this at all -- the zone is not a parameter, deliberately: a cap is
 * counted against the deployment's day, and threading a zone through every call
 * site would make that a per-caller choice.
 */
function inZone(zone: string, fn: () => void): void {
  process.env.TZ = zone;
  fn();
}

afterEach(() => {
  process.env.TZ = TZ;
});

describe('startOfToday follows the deployment timezone', () => {
  it('is UTC midnight when the process has no zone of its own', () => {
    inZone('UTC', () => {
      const at = new Date('2026-08-17T00:13:58Z');
      expect(startOfToday(at).toISOString()).toBe('2026-08-17T00:00:00.000Z');
    });
  });

  it('is the operator\'s midnight when the container has been told one', () => {
    // Europe/Sofia is UTC+3 in August, so the day began three hours before the
    // UTC one did.
    inZone('Europe/Sofia', () => {
      const at = new Date('2026-08-17T00:13:58Z');
      expect(startOfToday(at).toISOString()).toBe('2026-08-16T21:00:00.000Z');
    });
  });

  it('keeps last night inside today, which is the whole point', () => {
    // THE measured failure. 00:13 UTC is 03:13 in Sofia, and the 156 handouts
    // stamped at 23:04-23:58 UTC were 02:04-02:58 that same local morning. In
    // UTC they are yesterday's; the cap bar read 0/240 and the account was
    // handed a fresh day's budget at three in the morning.
    const evening = new Date('2026-08-16T23:04:07Z');
    const at = new Date('2026-08-17T00:13:58Z');

    inZone('UTC', () => {
      expect(evening >= startOfToday(at)).toBe(false);
    });
    inZone('Europe/Sofia', () => {
      expect(evening >= startOfToday(at)).toBe(true);
    });
  });

  it('rolls over at the operator\'s midnight and not before', () => {
    inZone('Europe/Sofia', () => {
      // 20:59:59Z is 23:59:59 local -- still yesterday.
      const before = startOfToday(new Date('2026-08-16T20:59:59Z'));
      const after = startOfToday(new Date('2026-08-16T21:00:00Z'));
      expect(before.toISOString()).toBe('2026-08-15T21:00:00.000Z');
      expect(after.toISOString()).toBe('2026-08-16T21:00:00.000Z');
    });
  });

  it('reads its clock rather than being handed one, in production', () => {
    // The seam exists for the tests above. A caller that had to supply `now`
    // would eventually supply two different ones in the same request.
    expect(startOfToday.length).toBe(0);
    const drift = Math.abs(startOfToday().getTime() - startOfToday(new Date()).getTime());
    expect(drift).toBeLessThan(1000);
  });
});

describe('utcLiteral survives a session timezone', () => {
  it('writes the instant Postgres can compare to a naive UTC column', () => {
    expect(utcLiteral(new Date('2026-08-16T21:00:00.000Z'))).toBe('2026-08-16 21:00:00.000');
  });

  it('is the zone-independent half of the pair', () => {
    // The literal is derived from the instant, so a container in Sofia and one
    // in UTC that agree on the boundary also agree on its literal. What differs
    // between them is which boundary startOfToday picks, and nothing else.
    const at = new Date('2026-08-17T00:13:58Z');
    let sofia = '';
    inZone('Europe/Sofia', () => {
      sofia = utcLiteral(startOfToday(at));
    });
    expect(sofia).toBe('2026-08-16 21:00:00.000');
  });
});
