/**
 * The two counters that replaced "handed out" on the account row.
 *
 * Both are subtractions over rows the dashboard rollup already fetched, and a
 * subtraction is exactly the kind of arithmetic that is plausible and wrong: it
 * can double-count, it can go negative, and it can be right for one account and
 * wrong for the tenth. Neither can be checked against a fake -- what is being
 * asserted is that the numbers agree with what Postgres holds -- so they are
 * checked here, against a real ledger with real assignments in it.
 *
 *   rejected          people this personality holds that no account was given.
 *                     A drop in PipelineService.filter is a bare `continue`, so
 *                     "no assignment row" is the only trace a refusal leaves,
 *                     and this is the first time that number reaches the UI.
 *   alreadyFollowed   people a SIBLING account already followed. UNIQUE
 *                     (personId) means this account is never getting them.
 *
 * The sibling case is the one worth the fixture cost. With a single account
 * alreadyFollowed is always 0 and a broken implementation passes; it is the
 * second account of a personality where the answer stops being trivial, and the
 * product runs up to ten.
 *
 * A third counter joined them later and fails differently:
 *
 *   failedToday       attempts this account made today that missed. Not a state
 *                     count -- nothing in the server ever writes
 *                     `state = 'failed'` -- so the failure mode here is not a
 *                     subtraction going negative but a column that is silently
 *                     always 0. Its tests go through TargetsService.report,
 *                     because what is being asserted is that the count agrees
 *                     with what that method really writes.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  addPeople,
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

/** Move `count` of an account's queued rows into some other state. */
async function setState(
  accountId: string,
  state: 'followed' | 'handed_out' | 'skipped' | 'failed',
  count: number,
): Promise<void> {
  const rows = await prisma.assignment.findMany({
    where: { accountId, state: 'queued' },
    select: { id: true },
    take: count,
  });
  await prisma.assignment.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { state, resultAt: new Date() },
  });
}

/** The one personality's account rows, by label, from the dashboard rollup. */
async function accountsOf(clientId: string, personalityId: string) {
  const list = await personalities.list(clientId);
  const p = list.find((row) => row.id === personalityId)!;
  return new Map(p.accounts.map((a) => [a.label, a]));
}

describe('alreadyFollowed: what a sibling account has taken', () => {
  it('is 0 for the account that did the following, and the count for its sibling', async () => {
    const client = await makeClient({ accounts: 2 });
    const [a, b] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 5, 'ona');
    await setState(a.id, 'followed', 3);

    const rows = await accountsOf(client.id, client.personality.id);

    // a followed them, so they are a's work, not a's blocked list.
    expect(rows.get(a.label)).toMatchObject({ followed: 3, queued: 2, alreadyFollowed: 0 });
    // b can never be handed those three -- Assignment.personId is unique -- and
    // that is the whole reason the column exists.
    expect(rows.get(b.label)).toMatchObject({ followed: 0, queued: 0, alreadyFollowed: 3 });
  });

  it('counts only followed siblings, not queued or handed-out ones', async () => {
    const client = await makeClient({ accounts: 2 });
    const [a, b] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 6, 'mix');
    await setState(a.id, 'followed', 1);
    await setState(a.id, 'handed_out', 2);
    await setState(a.id, 'skipped', 1);
    // 1 followed, 2 handed_out, 1 skipped, 2 still queued.

    const rows = await accountsOf(client.id, client.personality.id);

    // Only the followed one. A person a is still working is not a person b has
    // permanently lost -- a failure requeues, and the row can move again.
    expect(rows.get(b.label)!.alreadyFollowed).toBe(1);
    expect(rows.get(a.label)!.alreadyFollowed).toBe(0);
  });

  it('sums across every sibling, not just the busiest one', async () => {
    const client = await makeClient({ accounts: 3 });
    const [a, b, c] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 2, 'froma');
    await queueTargets(client.personality.id, b.id, 4, 'fromb');
    await setState(a.id, 'followed', 2);
    await setState(b.id, 'followed', 4);

    const rows = await accountsOf(client.id, client.personality.id);

    expect(rows.get(a.label)!.alreadyFollowed).toBe(4);
    expect(rows.get(b.label)!.alreadyFollowed).toBe(2);
    // The third account has followed nobody, so everything both siblings took
    // is out of its reach.
    expect(rows.get(c.label)!.alreadyFollowed).toBe(6);
  });

  it('does not reach across personalities', async () => {
    // kris and mia may both follow the same handle: the dedupe is scoped to the
    // personality, so mia's follows are not something kris's account has lost.
    const client = await makeClient({ accounts: 1 });
    const mia = await addPersonality(client.id, { accounts: 1 });
    await queueTargets(mia.id, mia.accounts[0].id, 4, 'mias');
    await setState(mia.accounts[0].id, 'followed', 4);

    const kris = await accountsOf(client.id, client.personality.id);
    expect(kris.get(client.personality.accounts[0].label)!.alreadyFollowed).toBe(0);
  });
});

describe('rejected: the people the filter dropped', () => {
  it('counts a person with no assignment exactly once, on every account row', async () => {
    const client = await makeClient({ accounts: 2 });
    const [a, b] = client.personality.accounts;
    // 3 forwarded to a, 4 refused -- people in the ledger with no assignment,
    // which is all a drop leaves behind.
    await queueTargets(client.personality.id, a.id, 3, 'kept');
    await addPeople(client.personality.id, 4, 'dropped');

    const rows = await accountsOf(client.id, client.personality.id);

    // The same number on both rows, because it is a property of the
    // personality. Not 8, which is what summing it per account would give.
    expect(rows.get(a.label)!.rejected).toBe(4);
    expect(rows.get(b.label)!.rejected).toBe(4);
    expect(
      await prisma.person.count({
        where: { personalityId: client.personality.id, assignment: { is: null } },
      }),
    ).toBe(4);
  });

  it('does not count a person whose assignment is in a terminal state', async () => {
    const client = await makeClient({ accounts: 1 });
    const [a] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 4, 'terminal');
    await setState(a.id, 'skipped', 2);
    await setState(a.id, 'failed', 1);

    const rows = await accountsOf(client.id, client.personality.id);

    // Skipped and failed were forwarded -- the filter approved them and the
    // machine decided otherwise. Only the filter's own drops are `rejected`.
    expect(rows.get(a.label)!.rejected).toBe(0);
  });

  it('is 0, not negative, for a personality that holds nobody', async () => {
    const client = await makeClient({ accounts: 1 });
    const rows = await accountsOf(client.id, client.personality.id);
    expect(rows.get(client.personality.accounts[0].label)!.rejected).toBe(0);
  });

  it('agrees with `people` minus everything assigned', async () => {
    const client = await makeClient({ accounts: 2 });
    const [a, b] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 5, 'toa');
    await queueTargets(client.personality.id, b.id, 3, 'tob');
    await addPeople(client.personality.id, 7, 'nobody');
    await setState(a.id, 'followed', 2);

    const list = await personalities.list(client.id);
    const p = list.find((row) => row.id === client.personality.id)!;

    expect(p.people).toBe(15);
    for (const account of p.accounts) {
      expect(account.rejected).toBe(p.people - 8);
    }
  });

  it('does not reach across personalities', async () => {
    const client = await makeClient({ accounts: 1 });
    const mia = await addPersonality(client.id, { accounts: 1 });
    await addPeople(mia.id, 9, 'miadrop');

    const kris = await accountsOf(client.id, client.personality.id);
    expect(kris.get(client.personality.accounts[0].label)!.rejected).toBe(0);
  });
});

describe('the account row shape', () => {
  it('no longer carries handedOut, and still carries the cap-bar numbers', async () => {
    const client = await makeClient({ accounts: 1 });
    const [a] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 2, 'shape');

    const rows = await accountsOf(client.id, client.personality.id);
    const row = rows.get(a.label)!;

    expect(Object.keys(row).sort()).toEqual([
      'alreadyFollowed',
      'dailyCap',
      'enabled',
      'failedToday',
      'followed',
      // Added when the cap bar started drawing follows landed rather than cap
      // slots taken. The shape assertion is the whole point of this test, so it
      // is listed here rather than loosened to a subset.
      'followedToday',
      'handedToday',
      'id',
      'label',
      'queued',
      'rejected',
      'remainingToday',
    ]);
    // handedToday and dailyCap are the daily-cap bar -- the safety feature, and
    // a different column from the `handed out` state count that was removed.
    // remainingToday is computed from handedToday, so losing it loses both.
    expect(row.handedToday).toBe(0);
    expect(row.remainingToday).toBe(row.dailyCap);
    expect((row as unknown as Record<string, unknown>).handedOut).toBeUndefined();
  });

  /**
   * The registration reply is the same projection by a different route, and the
   * agent adopts it and starts its first cycle from it without a second fetch.
   * Its counters come from a groupBy scoped to the personality rather than to
   * the one account, so this is where "the tenth machine reports 0 blocked
   * handles" would show up.
   */
  it('a machine registering itself is told what its siblings have taken', async () => {
    const client = await makeClient({ accounts: 1 });
    const [a] = client.personality.accounts;
    await queueTargets(client.personality.id, a.id, 4, 'sib');
    await setState(a.id, 'followed', 4);
    await addPeople(client.personality.id, 2, 'refused');

    const out = await personalities.registerAccount(client.id, client.personality.id, {
      handle: 'newbox',
    });

    expect(out.created).toBe(true);
    expect(out.account).toMatchObject({
      label: 'newbox',
      queued: 0,
      followed: 0,
      alreadyFollowed: 4,
      rejected: 2,
      // Zero for a machine registering itself, and it has to be present rather
      // than absent: the agent adopts this object and would find the field
      // missing on its first cycle if the two projections drifted apart.
      failedToday: 0,
    });
  });
});

/**
 * failedToday: attempts that missed, counted from what report() actually writes.
 *
 * The column that suggests itself is `state = 'failed'`, and it would read 0
 * forever. TargetsService.report stores a failure as `state: 'queued'` -- the row
 * goes back in the queue so it is retried rather than lost -- so nothing in the
 * server ever writes the enum value that shares the name. A column that is
 * always 0 is worse than no column, because 0 reads as good news.
 *
 * What a failure does leave is `queued` WITH a `resultAt`, and no other path
 * produces that pair: allocate() queues with no resultAt, claim() writes no
 * resultAt, and report() is the only way back to queued. So these tests go
 * through report() rather than through an updateMany, because the whole claim
 * being made is about what that one method writes.
 */
describe('failedToday: what a reported failure leaves behind', () => {
  it('counts a failure, which is stored as queued and never as failed', async () => {
    const client = await makeClient({ accounts: 1 });
    const [a] = client.personality.accounts;
    const handles = await queueTargets(client.personality.id, a.id, 3, 'miss');
    await targets.claim(a.id, 3);
    await targets.report(a.id, handles[0], 'failed', 'no row read as that handle');
    await targets.report(a.id, handles[1], 'failed');

    const rows = await accountsOf(client.id, client.personality.id);
    expect(rows.get(a.label)!.failedToday).toBe(2);

    // The evidence for why the obvious column would have been empty.
    expect(await prisma.assignment.count({ where: { accountId: a.id, state: 'failed' } })).toBe(0);
    // And they really are back in the queue: failedToday is a subset of queued,
    // not a state beside it. TWO, not three: the claim above took all three rows
    // and only two were reported, so the third is still handed_out and is not
    // queued by any reading. This asserted 3 from the day it was written and has
    // never once passed -- `queued` counts state='queued' and always has.
    expect(rows.get(a.label)!.queued).toBe(2);
    expect(
      await prisma.assignment.count({ where: { accountId: a.id, state: 'handed_out' } }),
    ).toBe(1);
  });

  it('counts a failure reported with no note at all', async () => {
    // ReportDto.note is optional, so requiring a note would silently undershoot
    // for any agent that reports a bare failure. resultAt is unconditional.
    const client = await makeClient({ accounts: 1 });
    const [a] = client.personality.accounts;
    const [handle] = await queueTargets(client.personality.id, a.id, 1, 'quiet');
    await targets.claim(a.id, 1);
    await targets.report(a.id, handle, 'failed');

    const rows = await accountsOf(client.id, client.personality.id);
    expect(rows.get(a.label)!.failedToday).toBe(1);
  });

  it('does not count a follow, a skip, or a row nobody has attempted', async () => {
    const client = await makeClient({ accounts: 1 });
    const [a] = client.personality.accounts;
    const handles = await queueTargets(client.personality.id, a.id, 4, 'mixed');
    await targets.claim(a.id, 3);
    await targets.report(a.id, handles[0], 'followed');
    await targets.report(a.id, handles[1], 'skipped', 'not on the roster');
    await targets.report(a.id, handles[2], 'failed');
    // handles[3] was never claimed and never reported.

    const rows = await accountsOf(client.id, client.personality.id);
    expect(rows.get(a.label)!.failedToday).toBe(1);
  });

  it('does not count a failure from a previous day', async () => {
    const client = await makeClient({ accounts: 1 });
    const [a] = client.personality.accounts;
    const [handle] = await queueTargets(client.personality.id, a.id, 1, 'yday');
    await targets.claim(a.id, 1);
    await targets.report(a.id, handle, 'failed');
    // Backdated rather than reported yesterday, which is the only way to have a
    // yesterday in a test. The row is otherwise byte-identical to the one above.
    await prisma.assignment.updateMany({
      where: { accountId: a.id },
      data: { resultAt: new Date(Date.now() - 36 * 60 * 60 * 1000) },
    });

    const rows = await accountsOf(client.id, client.personality.id);
    expect(rows.get(a.label)!.failedToday).toBe(0);
    // Still queued and still retriable -- it is the counter that is scoped to
    // today, not the row.
    expect(rows.get(a.label)!.queued).toBe(1);
  });

  it('is this account’s own number, not the personality’s', async () => {
    // rejected and alreadyFollowed are properties of the whole personality and
    // read the same on every row of a card. This one must not.
    const client = await makeClient({ accounts: 2 });
    const [a, b] = client.personality.accounts;
    const handles = await queueTargets(client.personality.id, a.id, 2, 'mine');
    await targets.claim(a.id, 2);
    await targets.report(a.id, handles[0], 'failed');

    const rows = await accountsOf(client.id, client.personality.id);
    expect(rows.get(a.label)!.failedToday).toBe(1);
    expect(rows.get(b.label)!.failedToday).toBe(0);
  });
});
