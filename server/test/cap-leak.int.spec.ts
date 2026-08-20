/**
 * The two ways a 240/day account did 280 adds in a day.
 *
 * The cap is spent at HANDOUT and the add happens later, so the two halves of
 * one slot can be separated -- and both of the gaps that opened between them
 * were invisible from the dashboard, which draws follows against a cap that was
 * never enforced on follows.
 *
 * Measured on the live CRM for 2026-08-19, against dailyCapPerAccount = 240:
 *
 *     account         slots charged   follows landed
 *     stephaniecvto             363              280
 *     haileodx                  289              277
 *     haelpjle                  262              260
 *
 * Every one of those follows still carried a stamp dated that same day, so
 * nothing had been orphaned and no reset had been pressed. The budget was handed
 * back by the stale-handout sweep and spent again, all day long.
 *
 * These are int tests because both leaks live in the arithmetic claim() does
 * under its row lock, against columns only a real Postgres will date honestly.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { dropFixtures, makeClient, personalities, prisma, queueTargets, targets } from './fixtures';

afterEach(dropFixtures);
afterAll(() => prisma.$disconnect());

/** Age a row's handout stamp, which is the only way to reach the sweep in a test. */
async function backdateHandout(accountId: string, minutes: number, take = 1) {
  const rows = await prisma.assignment.findMany({
    where: { accountId, state: 'handed_out' },
    take,
    select: { id: true },
  });
  await prisma.assignment.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { handedOutAt: new Date(Date.now() - minutes * 60_000) },
  });
  return rows.map((r) => r.id);
}

describe('a slot spent stays spent', () => {
  it('requeues a handout nobody answered for without giving the cap back', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 10 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);

    const first = await targets.claim(account.id, 10);
    expect(first.targets).toHaveLength(10);
    expect(await targets.remainingToday(account.id)).toBe(0);

    // The agent died here: four rows were handed out and never answered for.
    // On the phone, some of those adds may well have happened -- that is exactly
    // what cannot be known, and why the budget must not come back.
    const stale = await backdateHandout(account.id, 90, 4);

    const second = await targets.claim(account.id, 10);

    // Requeued, so the PEOPLE are not lost -- the rows are workable again, just
    // not today: claim() will not re-offer a row that still carries a stamp
    // inside today, which is the same guard that stops a machine reporting
    // "failed" in a loop from pulling one handle all day.
    const rows = await prisma.assignment.findMany({
      where: { id: { in: stale } },
      select: { state: true, handedOutAt: true },
    });
    expect(rows.every((r) => r.state === 'queued')).toBe(true);
    expect(rows.every((r) => r.handedOutAt !== null)).toBe(true);

    // ...but the SLOTS are. This is the whole fix: before it, `second` came back
    // with four more targets and the day quietly bought fourteen adds out of a
    // ten-add budget.
    expect(second.targets).toEqual([]);
    expect(await targets.remainingToday(account.id)).toBe(0);
  });

  it('lets the requeued row be worked again without charging twice for it', async () => {
    // The stamp is kept, not doubled: one row is one slot however many times it
    // is handed out, so tomorrow's claim is not punished for today's crash.
    const client = await makeClient({ accounts: 1, dailyCap: 10 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);

    await targets.claim(account.id, 6);
    await backdateHandout(account.id, 90, 6);
    await targets.claim(account.id, 10);

    expect(await prisma.assignment.count({
      where: { accountId: account.id, handedOutAt: { not: null } },
    })).toBe(10);
    expect(await targets.remainingToday(account.id)).toBe(0);
  });
});

describe('a follow that crossed midnight is charged to the day it landed', () => {
  /** A row handed out yesterday and followed today: the batch that straddled. */
  async function followedOnYesterdaysSlot(accountId: string, n: number) {
    const rows = await prisma.assignment.findMany({
      where: { accountId, state: 'queued' },
      take: n,
      select: { id: true },
    });
    const yesterday = new Date(Date.now() - 20 * 60 * 60_000);
    await prisma.assignment.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { state: 'followed', handedOutAt: yesterday, resultAt: new Date() },
    });
    return rows.length;
  }

  it('counts it against today, so the cap bounds adds rather than handouts', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 10 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);

    await followedOnYesterdaysSlot(account.id, 4);

    // Four adds already reached Snapchat today on budget taken yesterday, so six
    // is what is left. It used to be ten: the handout count saw nothing at all
    // for those rows, and the day bought fourteen adds against a cap of ten.
    expect(await targets.straddledToday(account.id)).toBe(4);
    expect(await targets.remainingToday(account.id)).toBe(6);

    const claimed = await targets.claim(account.id, 100);
    expect(claimed.targets).toHaveLength(6);
    expect(await targets.remainingToday(account.id)).toBe(0);
  });

  it('does not double-count a follow whose slot was charged the same day', async () => {
    // The two counts must not overlap, which is why claim() adds a narrow second
    // query instead of taking max(handed, followed): a same-day follow is
    // already paid for by its own handout.
    const client = await makeClient({ accounts: 1, dailyCap: 10 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);

    const claimed = await targets.claim(account.id, 3);
    for (const t of claimed.targets) {
      await targets.report(account.id, t.handle, 'followed');
    }

    expect(await targets.straddledToday(account.id)).toBe(0);
    expect(await targets.remainingToday(account.id)).toBe(7);
  });
});

describe('reset cap returns slots, not adds', () => {
  it('does not hand back budget for follows Snapchat has already seen', async () => {
    // The method's own warning said this: "an account that really did 200 adds
    // today and is reset will be handed a fresh dailyCap and will spend it
    // against a cooldown that will not lift". It was handed one because the
    // number was a literal.
    const client = await makeClient({ accounts: 1, dailyCap: 10 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);

    const claimed = await targets.claim(account.id, 8);
    for (const t of claimed.targets.slice(0, 6)) {
      await targets.report(account.id, t.handle, 'followed');
    }

    const after = await personalities.resetDailyCap(client.id, account.id);

    // The two rows that were still mid-flight come back as work...
    expect(after.requeued).toBe(2);
    expect(after.handedToday).toBe(0);
    // ...and the six real adds go on counting, so a reset frees four slots and
    // not ten. Re-running a test still resets cleanly, because a test has not
    // followed anybody.
    expect(after.remainingToday).toBe(4);
    expect(await targets.remainingToday(account.id)).toBe(4);
  });
});
