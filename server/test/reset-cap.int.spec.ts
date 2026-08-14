/**
 * The per-account daily-cap reset, and the four ways it could destroy data.
 *
 * The operator's need is small -- "let me run the same test twice today" -- and
 * the implementation is two UPDATEs over the ledger, which is the part that is
 * not small. Both caps are metered by counting `handedOutAt`, so the reset is
 * literally "clear today's stamps on this account", and every hazard below is a
 * consequence of that column being load-bearing for more than one thing:
 *
 *   un-following      handedOutAt is cleared on rows that are already
 *                     `followed`. If `state` were written unconditionally the
 *                     acquisition would vanish from the ledger and the CSV, and
 *                     the person would become claimable again -- the same
 *                     person followed twice, which UNIQUE (personId) exists to
 *                     make impossible.
 *   resurrecting      a `skipped` row is terminal because re-offering it loops
 *                     (TargetsService.report). Flipping it to queued re-offers
 *                     a declined person every cycle, forever.
 *   stranding         the destructive-by-omission one. Clearing the stamp on a
 *                     `handed_out` row without flipping it back to `queued`
 *                     leaves a row no cap counts and no claim will ever pick
 *                     (claim() filters state='queued'). It is deleted from the
 *                     working set while still sitting in the table.
 *   over-reaching     handedOutAt from earlier days is the audit column the
 *                     ledger, the targets list and the CSV all read.
 *
 * None of these can be checked against a fake: what is being asserted is what
 * Postgres holds after the transaction, and that a subsequent real claim can or
 * cannot pick the rows up.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  addPersonality,
  dropFixtures,
  makeClient,
  personalities,
  prisma,
  queueTargets,
  targets,
} from './fixtures';

afterEach(dropFixtures);
afterAll(async () => {
  await prisma.$disconnect();
});

/** state -> how many of this account's assignments are in it. */
async function statesOf(accountId: string): Promise<Record<string, number>> {
  const rows = await prisma.assignment.groupBy({
    by: ['state'],
    where: { accountId },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.state, r._count._all]));
}

async function stamped(accountId: string): Promise<number> {
  return prisma.assignment.count({ where: { accountId, handedOutAt: { not: null } } });
}

describe('resetDailyCap: giving one account today back', () => {
  it('frees exactly the rows handed out today, and says how many', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 10 });
    const [a] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 12, 'today');
    const claimed = await targets.claim(a.id, 10);
    expect(claimed.targets).toHaveLength(10);
    expect(await targets.handedOutToday(a.id)).toBe(10);

    const out = await personalities.resetDailyCap(client.id, a.id);

    expect(out).toMatchObject({
      id: a.id,
      label: a.label,
      // All ten were claimed and never reported, so all ten were mid-flight.
      requeued: 10,
      cleared: 10,
      handedToday: 0,
      remainingToday: 10,
    });
    // The number in the reply is the number in the database, not an estimate.
    expect(await targets.handedOutToday(a.id)).toBe(0);
    expect(await stamped(a.id)).toBe(0);
  });

  it('lets the same account be handed a full cap again the same day', async () => {
    // This is the entire point of the button: re-run the test without waiting
    // for midnight.
    const client = await makeClient({ accounts: 1, dailyCap: 5 });
    const [a] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 5, 'again');
    expect((await targets.claim(a.id, 5)).targets).toHaveLength(5);
    // Spent: the cap binds and the queue is irrelevant.
    expect((await targets.claim(a.id, 5)).targets).toHaveLength(0);

    await personalities.resetDailyCap(client.id, a.id);

    expect((await targets.claim(a.id, 5)).targets).toHaveLength(5);
  });

  it('requeues rows that were claimed and never reported, instead of stranding them', async () => {
    // claim() only ever picks state='queued'. Clearing the stamp without
    // flipping the state back would leave these rows uncountable AND
    // unclaimable -- silently gone, with nothing missing from the table.
    const client = await makeClient({ accounts: 1, dailyCap: 4 });
    const [a] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 4, 'inflight');
    await targets.claim(a.id, 4);
    expect(await statesOf(a.id)).toMatchObject({ handed_out: 4 });

    const out = await personalities.resetDailyCap(client.id, a.id);

    expect(out.requeued).toBe(4);
    expect(await statesOf(a.id)).toEqual({ queued: 4 });
    expect((await targets.claim(a.id, 4)).targets).toHaveLength(4);
  });

  it('does not un-follow anyone', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 6 });
    const [a] = client.personality.accounts;
    const handles = await queueTargets(client.personality.id, a.id, 3, 'kept');
    await targets.claim(a.id, 3);
    for (const handle of handles) await targets.report(a.id, handle, 'followed');
    const followedAt = await prisma.assignment.findMany({
      where: { accountId: a.id },
      select: { id: true, resultAt: true },
      orderBy: { id: 'asc' },
    });

    const out = await personalities.resetDailyCap(client.id, a.id);

    // Three cap slots came back and nothing was mid-flight.
    expect(out).toMatchObject({ requeued: 0, cleared: 3 });
    expect(await statesOf(a.id)).toEqual({ followed: 3 });
    // The stamp is gone, which frees the budget, and the row is still
    // unreachable to a claim because claim() only picks queued. So the person
    // cannot be handed out a second time.
    expect(await stamped(a.id)).toBe(0);
    expect((await targets.claim(a.id, 6)).targets).toHaveLength(0);
    // resultAt is untouched: it is when the follow happened, and the Followed
    // screen and the CSV both date the acquisition from it.
    expect(
      await prisma.assignment.findMany({
        where: { accountId: a.id },
        select: { id: true, resultAt: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(followedAt);
  });

  it('does not resurrect a skipped row', async () => {
    // A skip is terminal because the account decided against the person and
    // re-offering would loop it back every cycle.
    const client = await makeClient({ accounts: 1, dailyCap: 6 });
    const [a] = client.personality.accounts;
    const handles = await queueTargets(client.personality.id, a.id, 2, 'declined');
    await targets.claim(a.id, 2);
    for (const handle of handles) await targets.report(a.id, handle, 'skipped', 'not on roster');

    await personalities.resetDailyCap(client.id, a.id);

    expect(await statesOf(a.id)).toEqual({ skipped: 2 });
    expect((await targets.claim(a.id, 6)).targets).toHaveLength(0);
  });

  it('keeps the failure notes and the failed-today count', async () => {
    // `note` is the most diagnostic string in the system and resultAt is what
    // failedToday counts. A reset that wiped either would make the operator's
    // second run start from a blank record of why the first one missed -- and a
    // row that failed today HAS failed today, whether or not the cap was reset.
    const client = await makeClient({ accounts: 1, dailyCap: 6 });
    const [a] = client.personality.accounts;
    const handles = await queueTargets(client.personality.id, a.id, 2, 'missed');
    await targets.claim(a.id, 2);
    await targets.report(a.id, handles[0], 'failed', 'no row read as that handle');

    const before = (await personalities.list(client.id))[0].accounts[0].failedToday;
    expect(before).toBe(1);

    await personalities.resetDailyCap(client.id, a.id);

    const after = (await personalities.list(client.id))[0].accounts[0];
    expect(after.failedToday).toBe(1);
    expect(after.handedToday).toBe(0);
    expect(
      await prisma.assignment.count({
        where: { accountId: a.id, note: 'no row read as that handle' },
      }),
    ).toBe(1);
  });

  it('leaves handouts from earlier days alone', async () => {
    // handedOutAt is the audit column the ledger, the targets list and the CSV
    // all read. Clearing it for older rows loses when a person was handed out,
    // for no budget at all -- yesterday's rows are not part of today's cap.
    const client = await makeClient({ accounts: 1, dailyCap: 10 });
    const [a] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 6, 'history');
    await targets.claim(a.id, 6);
    const yesterday = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const old = await prisma.assignment.findMany({
      where: { accountId: a.id },
      select: { id: true },
      take: 4,
    });
    await prisma.assignment.updateMany({
      where: { id: { in: old.map((r) => r.id) } },
      data: { handedOutAt: yesterday, state: 'followed' },
    });

    const out = await personalities.resetDailyCap(client.id, a.id);

    expect(out).toMatchObject({ requeued: 2, cleared: 2 });
    expect(
      await prisma.assignment.count({ where: { accountId: a.id, handedOutAt: yesterday } }),
    ).toBe(4);
  });

  it('touches no sibling account', async () => {
    const client = await makeClient({ accounts: 2, dailyCap: 5 });
    const [a, b] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 5, 'ona');
    await queueTargets(client.personality.id, b.id, 5, 'onb');
    await targets.claim(a.id, 5);
    await targets.claim(b.id, 5);

    await personalities.resetDailyCap(client.id, a.id);

    expect(await targets.handedOutToday(a.id)).toBe(0);
    expect(await targets.handedOutToday(b.id)).toBe(5);
    expect(await statesOf(b.id)).toEqual({ handed_out: 5 });
  });

  it('refuses another client’s account with a 404, and changes nothing', async () => {
    // The id is the secret, so 404 rather than 403 -- the same choice
    // updateAccount and exportTargets make. Without the scope, an account id
    // printed in one operator's UI rewrites another tenant's ledger.
    const mine = await makeClient({ accounts: 1, dailyCap: 5 });
    const theirs = await makeClient({ accounts: 1, dailyCap: 5 });
    const victim = theirs.personality.accounts[0];
    await queueTargets(theirs.personality.id, victim.id, 5, 'theirs');
    await targets.claim(victim.id, 5);

    await expect(personalities.resetDailyCap(mine.id, victim.id)).rejects.toThrow(
      /account not found/,
    );
    expect(await targets.handedOutToday(victim.id)).toBe(5);
    expect(await statesOf(victim.id)).toEqual({ handed_out: 5 });
  });

  it('reaches a second personality of the same client', async () => {
    // Scoped by clientId, not by personality: the operator owns both cards on
    // the dashboard and the button sits on every account row.
    const client = await makeClient({ accounts: 1 });
    const mia = await addPersonality(client.id, { accounts: 1 });
    const account = mia.accounts[0];
    await queueTargets(mia.id, account.id, 3, 'mias');
    await targets.claim(account.id, 3);

    const out = await personalities.resetDailyCap(client.id, account.id);

    expect(out.cleared).toBe(3);
    expect(await targets.handedOutToday(account.id)).toBe(0);
  });

  it('answers 0 on an account that has been handed nothing', async () => {
    // Pressing the button twice is not an error, and neither is pressing it on
    // a fresh account -- both are what an operator does while testing.
    const client = await makeClient({ accounts: 1, dailyCap: 9 });
    const [a] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 2, 'untouched');

    const first = await personalities.resetDailyCap(client.id, a.id);
    const second = await personalities.resetDailyCap(client.id, a.id);

    expect(first).toMatchObject({ requeued: 0, cleared: 0, handedToday: 0, remainingToday: 9 });
    expect(second).toMatchObject({ requeued: 0, cleared: 0 });
    expect(await statesOf(a.id)).toEqual({ queued: 2 });
  });

  it('frees the rolling session window as well as the day', async () => {
    // Both caps count the same column, so one button releases both. Worth
    // pinning: an operator who reset the day and still got nothing back would
    // have no way to tell which of the two limits was still holding.
    const client = await makeClient({ accounts: 1, dailyCap: 50, sessionCap: 3, sessionWindow: 60 });
    const [a] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 6, 'window');
    const first = await targets.claim(a.id, 6);
    expect(first.targets).toHaveLength(3);
    expect(first.remainingInWindow).toBe(0);

    await personalities.resetDailyCap(client.id, a.id);

    const second = await targets.claim(a.id, 6);
    expect(second.targets).toHaveLength(3);
    expect(second.remainingInWindow).toBe(0);
  });
});
