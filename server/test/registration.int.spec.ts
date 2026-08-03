/**
 * Two machines registering the same handle at the same instant.
 *
 * This is not a contrived race. A personality selected on two boxes pointed at
 * one emulator image, or a single agent retried by its own jittered backoff
 * after a reply was lost, both put two identical registrations in flight -- and
 * the client method retries *because* the endpoint is specified as an upsert.
 *
 * Two accounts for one Snapchat handle would be the expensive outcome: two rows
 * with separate daily caps, so one account is worked at twice its cap, and the
 * follows land against whichever row happened to answer. UNIQUE (personalityId,
 * label) is what actually prevents it; this asserts the service turns that
 * constraint into the answer the loser is owed rather than a 500.
 *
 * Service-level, like the rest of the int project: what is under test is the
 * write path against real Postgres, not the controller.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { dropFixtures, makeClient, personalities, prisma } from './fixtures';

afterEach(dropFixtures);
afterAll(async () => {
  await prisma.$disconnect();
});

describe('concurrent identical registrations', () => {
  it('yield one account, and both callers get it', async () => {
    const c = await makeClient({ accounts: 0 });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        personalities.registerAccount(c.id, c.personality.id, { handle: 'iraxcvp' }),
      ),
    );

    const rows = await prisma.account.findMany({
      where: { personalityId: c.personality.id },
    });
    expect(rows).toHaveLength(1);

    // Exactly one call created it, and every other call is told so -- `created`
    // is the answer to "did I make this", which only one of them did.
    expect(results.filter((r) => r.created)).toHaveLength(1);
    // The part that matters to the machine: nobody gets an error, and everybody
    // gets the same account. A loser that threw would be a box that cannot
    // resolve its account and therefore never runs.
    expect(new Set(results.map((r) => r.account.id))).toEqual(new Set([rows[0].id]));
  });

  it('a losing caller still gets live counters, not a half-built object', async () => {
    const c = await makeClient({ accounts: 0 });

    const [a, b] = await Promise.all([
      personalities.registerAccount(c.id, c.personality.id, { handle: 'iraxcvp' }),
      personalities.registerAccount(c.id, c.personality.id, { handle: 'iraxcvp' }),
    ]);

    // The re-read after the unique violation goes through the same projection
    // as the winning create, so the agent cannot tell which side it was on.
    for (const r of [a, b]) {
      expect(r.account.remainingToday).toBe(r.account.dailyCap);
      expect(r.account).toMatchObject({ label: 'iraxcvp', enabled: true, queued: 0 });
    }
  });
});
