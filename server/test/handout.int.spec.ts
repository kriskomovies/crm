/**
 * The metered handout and the result callback.
 *
 * GET /v1/accounts/:id/targets is not a read: it claims rows and spends both the
 * daily cap and the rolling session window. Its correctness properties --
 * "never the same person twice", "never more than the daily cap", "never more
 * than the session cap in one window" -- are only observable against a real
 * Postgres under real concurrency, which is why FOR UPDATE SKIP LOCKED is in
 * the service and why these tests exist.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { dropFixtures, makeClient, prisma, queueTargets, targets } from './fixtures';

afterEach(dropFixtures);
afterAll(() => prisma.$disconnect());

describe('metered claim', () => {
  it('hands out exactly the daily cap and then nothing', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 7 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 20);

    expect(await targets.remainingToday(account.id)).toBe(7);

    const first = await targets.claim(account.id, 100);
    expect(first.targets).toHaveLength(7);
    expect(await targets.remainingToday(account.id)).toBe(0);

    const second = await targets.claim(account.id, 100);
    expect(second.targets).toEqual([]);

    // The other 13 stay queued for tomorrow rather than being dropped.
    expect(
      await prisma.assignment.count({ where: { accountId: account.id, state: 'queued' } }),
    ).toBe(13);
    expect(
      await prisma.assignment.count({ where: { accountId: account.id, state: 'handed_out' } }),
    ).toBe(7);
  });

  /**
   * NEWEST first, and this reversed a deliberate earlier decision.
   *
   * A handle can only be followed while that person is still on the emulator's
   * Quick Add roster, and the roster is re-rolled every time Snapchat restarts
   * -- which the agent does after each batch, because it is the only thing that
   * produces new people. A row from an older sheet is therefore not stale, it
   * is unreachable.
   *
   * Measured on a live account at cap 50: oldest-first spent 18 of the 50 on
   * orphans from the previous sheet, every one of which missed, leaving 32
   * follows for a full day's budget.
   */
  it('claims the newest queued rows first, because older ones are off the device', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    const handles = await queueTargets(client.personality.id, account.id, 10);

    const claimed = await targets.claim(account.id, 4);
    expect(claimed.targets.map((c) => c.handle)).toEqual(handles.slice(-4).reverse());
  });

  it('prefers a fresh sheet over what an earlier one left behind', async () => {
    // The real shape of the bug: claim less than the first sheet produced, add
    // a second sheet, claim again. The second claim must draw on the new rows
    // rather than working through the orphans of the first.
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 10, 'older');
    await targets.claim(account.id, 4);

    const fresh = await queueTargets(client.personality.id, account.id, 10, 'newer');
    const second = await targets.claim(account.id, 5);

    expect(second.targets.map((c) => c.handle)).toEqual(fresh.slice(-5).reverse());
    expect(second.targets.every((c) => c.handle.startsWith('newer'))).toBe(true);
  });

  it('hands out nothing for a disabled account', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 5);
    await prisma.account.update({ where: { id: account.id }, data: { enabled: false } });

    expect(await targets.remainingToday(account.id)).toBe(0);
    expect((await targets.claim(account.id, 10)).targets).toEqual([]);
  });

  it('rejects an unknown account rather than returning an empty page', async () => {
    await expect(targets.remainingToday('no-such-account')).rejects.toThrow(NotFoundException);
  });
});

/**
 * The second cap, and the reason it is a window rather than a session.
 *
 * A young Snapchat account stops accepting adds at roughly 40 a day, so an
 * account handed the whole 240 back to back spends the tail of the day
 * attempting adds against a cooldown that will not lift. The operator's answer
 * is to work 40 on account A, rotate to B and C, and come back to A -- which
 * needs the server to refuse A the 41st until it is due.
 *
 * The server cannot see a session: it has no idea when a machine starts or
 * stops working an account. It can see handedOutAt, so the rule is counted over
 * a rolling window instead, and these tests are about that count rather than
 * about any notion of a session.
 */
describe('the session cap', () => {
  it('stops a claim short while the day still has plenty of budget', async () => {
    const client = await makeClient({
      accounts: 1,
      dailyCap: 50,
      sessionCap: 4,
      sessionWindow: 60,
    });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 20);

    const first = await targets.claim(account.id, 25);
    expect(first.targets).toHaveLength(4);
    expect(first.remainingInWindow).toBe(0);
    // The day is untouched. This is the whole shape of the feature: 46 more are
    // coming, just not in this window.
    expect(await targets.remainingToday(account.id)).toBe(46);

    const second = await targets.claim(account.id, 25);
    expect(second.targets).toEqual([]);
    expect(second.remainingInWindow).toBe(0);

    // The other 16 stay queued rather than being dropped, exactly as they do
    // when the daily cap is what stopped the claim.
    expect(
      await prisma.assignment.count({ where: { accountId: account.id, state: 'queued' } }),
    ).toBe(16);
  });

  /**
   * The pair of numbers that tell "the window is full" from "the queue is dry".
   *
   * An agent in the field reads a short batch with remainingToday still healthy
   * as proof the queue ran out, and on that proof it runs an irreversible pass
   * hiding people from its Quick Add roster. Once a session cap can also
   * truncate a batch, that proof is worthless on its own -- the rows it did not
   * get are people the CRM approved and is about to hand out in the next
   * window. remainingInWindow is what restores the distinction, so it is
   * asserted in both directions here rather than only where it is zero.
   */
  it('says which budget ran out, so a short batch is not read as a dry queue', async () => {
    const capped = await makeClient({ accounts: 1, dailyCap: 50, sessionCap: 4 });
    const cappedAccount = capped.personality.accounts[0];
    await queueTargets(capped.personality.id, cappedAccount.id, 20);

    const short = await targets.claim(cappedAccount.id, 25);
    expect(short.targets).toHaveLength(4);
    // Short batch, healthy day -- and the window says outright that it is the
    // reason, so the batch is not evidence of anything about the queue.
    expect(await targets.remainingToday(cappedAccount.id)).toBe(46);
    expect(short.remainingInWindow).toBe(0);

    const dry = await makeClient({ accounts: 1, dailyCap: 50, sessionCap: 10 });
    const dryAccount = dry.personality.accounts[0];
    await queueTargets(dry.personality.id, dryAccount.id, 3);

    const all = await targets.claim(dryAccount.id, 25);
    expect(all.targets).toHaveLength(3);
    // Equally short, and both budgets still have room. This one really is a
    // queue that ran out, and it has to stay distinguishable from the above.
    expect(await targets.remainingToday(dryAccount.id)).toBe(47);
    expect(all.remainingInWindow).toBe(7);
  });

  /**
   * The window ROLLS: budget returns as the oldest handouts age out of it, with
   * nothing scheduled and no session to end.
   *
   * handedOutAt is moved back three minutes against a one-minute window rather
   * than the other way round, because the rows have to leave the window while
   * staying inside today -- otherwise the daily count moves too and the test
   * would pass for the wrong reason. handedOutToday is asserted for that: a run
   * within three minutes of local midnight fails loudly here instead of
   * quietly proving nothing.
   */
  it('hands out again once the window has rolled off', async () => {
    const client = await makeClient({
      accounts: 1,
      dailyCap: 50,
      sessionCap: 4,
      sessionWindow: 1,
    });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 20);

    expect((await targets.claim(account.id, 25)).targets).toHaveLength(4);
    expect((await targets.claim(account.id, 25)).targets).toEqual([]);

    await prisma.assignment.updateMany({
      where: { accountId: account.id, handedOutAt: { not: null } },
      data: { handedOutAt: new Date(Date.now() - 3 * 60_000) },
    });
    expect(await targets.handedOutToday(account.id)).toBe(4);

    const second = await targets.claim(account.id, 25);
    expect(second.targets).toHaveLength(4);
    expect(second.remainingInWindow).toBe(0);
    // Eight spent against the day, which is the point of having both numbers:
    // the window came back, the day did not.
    expect(await targets.remainingToday(account.id)).toBe(42);
  });

  it('takes whichever of the two caps is lower, in either direction', async () => {
    const dayBinds = await makeClient({ accounts: 1, dailyCap: 3, sessionCap: 10 });
    const dayAccount = dayBinds.personality.accounts[0];
    await queueTargets(dayBinds.personality.id, dayAccount.id, 20);

    const byDay = await targets.claim(dayAccount.id, 25);
    expect(byDay.targets).toHaveLength(3);
    expect(await targets.remainingToday(dayAccount.id)).toBe(0);
    // Room left in the window, and it is real: it is the day that has to pass.
    expect(byDay.remainingInWindow).toBe(7);

    const windowBinds = await makeClient({ accounts: 1, dailyCap: 10, sessionCap: 3 });
    const windowAccount = windowBinds.personality.accounts[0];
    await queueTargets(windowBinds.personality.id, windowAccount.id, 20);

    const byWindow = await targets.claim(windowAccount.id, 25);
    expect(byWindow.targets).toHaveLength(3);
    expect(byWindow.remainingInWindow).toBe(0);
    expect(await targets.remainingToday(windowAccount.id)).toBe(7);
  });

  it('serves the window length, so a full account can size a wait', async () => {
    const client = await makeClient({ accounts: 1, sessionCap: 2, sessionWindow: 90 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 5);

    // Served whether or not the window is full, so a client never has to have
    // been capped once to know how long to sleep when it is.
    expect((await targets.claim(account.id, 1)).sessionWindowMinutes).toBe(90);
    expect((await targets.claim(account.id, 25)).sessionWindowMinutes).toBe(90);
  });

  /**
   * A session cap of 0 is a brake, exactly as a daily cap of 0 is: it stops
   * every account of the client at once without touching any of them. It must
   * not underflow into a negative remainingInWindow, which a client comparing
   * "> 0" would read correctly but one comparing "!== 0" would not.
   */
  it('hands out nothing at a session cap of zero, without going negative', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50, sessionCap: 0 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 5);

    const claimed = await targets.claim(account.id, 25);
    expect(claimed.targets).toEqual([]);
    expect(claimed.remainingInWindow).toBe(0);
    // Not "spent today" -- the day is whole, and only the window is shut.
    expect(await targets.remainingToday(account.id)).toBe(50);
  });

  /**
   * The degenerate setting the operator asks for second: a window of a day
   * makes the session cap a second, lower daily cap. Worth pinning because it
   * is the configuration in which the two caps are most easily confused for
   * each other, and because 1440 is the DTO's ceiling.
   */
  it('is a second daily cap when the window is a whole day', async () => {
    const client = await makeClient({
      accounts: 1,
      dailyCap: 240,
      sessionCap: 5,
      sessionWindow: 1440,
    });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 20);

    expect((await targets.claim(account.id, 100)).targets).toHaveLength(5);
    expect((await targets.claim(account.id, 100)).targets).toEqual([]);
    expect(await targets.remainingToday(account.id)).toBe(235);
  });
});

describe('concurrent claims', () => {
  it('never hands the same person to two callers', async () => {
    // Cap deliberately above the queue depth, so this measures SKIP LOCKED and
    // nothing else: every queued row should come out exactly once.
    const client = await makeClient({ accounts: 1, dailyCap: 200 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 50);

    const batches = await Promise.all([
      targets.claim(account.id, 20),
      targets.claim(account.id, 20),
      targets.claim(account.id, 20),
      targets.claim(account.id, 20),
    ]);

    const handles = batches.flatMap((b) => b.targets.map((r) => r.handle));
    expect(new Set(handles).size).toBe(handles.length);
    expect(handles.length).toBe(50);
    expect(
      await prisma.assignment.count({ where: { accountId: account.id, state: 'queued' } }),
    ).toBe(0);
  });

  /**
   * FAILING, and it is a real bug, not a flaky test.
   *
   * TargetsService.claim reads remainingToday() in one round trip and claims in
   * a second. Two polls that overlap between those two statements both read the
   * same "0 handed out today", both compute take = cap, and the SKIP LOCKED
   * claim then correctly gives each of them a DIFFERENT set of cap rows. The
   * rows are not duplicated -- but twice the cap goes out, which is the thing
   * the cap exists to prevent, and the emulator gets rate-limited exactly as if
   * there were no cap at all.
   *
   * Two emulator processes on one account, or a retry after a timeout while the
   * first request is still in flight, is the documented normal case here.
   */
  it('does not exceed the daily cap when two claims overlap', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 12 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);

    const [a, b] = await Promise.all([
      targets.claim(account.id, 25),
      targets.claim(account.id, 25),
    ]);

    const handles = [...a.targets.map((r) => r.handle), ...b.targets.map((r) => r.handle)];
    // SKIP LOCKED holds: no row is handed to both callers.
    expect(new Set(handles).size).toBe(handles.length);
    // The cap does not.
    expect(handles.length).toBeLessThanOrEqual(account.dailyCap);
    expect(
      await prisma.assignment.count({
        where: { accountId: account.id, handedOutAt: { not: null } },
      }),
    ).toBeLessThanOrEqual(account.dailyCap);
  });
});

describe('report', () => {
  it('treats followed as terminal', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 3);
    const [first] = (await targets.claim(account.id, 3)).targets;

    await targets.report(account.id, first.handle, 'followed', 'done');

    const row = await prisma.assignment.findFirst({
      where: { person: { personalityId: client.personality.id, handle: first.handle } },
    });
    expect(row!.state).toBe('followed');
    expect(row!.resultAt).not.toBeNull();
    expect(row!.note).toBe('done');

    // Terminal means it never comes back round: a further claim cannot see it.
    const again = await targets.claim(account.id, 10);
    expect(again.targets.map((r) => r.handle)).not.toContain(first.handle);
  });

  it('returns a failed follow to the queue, keeping it against today s cap', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 3);
    const claimed = await targets.claim(account.id, 3);
    const victim = claimed.targets[1].handle;

    await targets.report(account.id, victim, 'failed', 'rate limited by the app');

    const row = await prisma.assignment.findFirst({
      where: { person: { personalityId: client.personality.id, handle: victim } },
    });
    expect(row!.state).toBe('queued');
    // handedOutAt survives, so the attempt still counts -- otherwise a failing
    // account could loop and spend an unbounded number of follow slots.
    expect(row!.handedOutAt).not.toBeNull();
    expect(await targets.handedOutToday(account.id)).toBe(3);
  });

  /**
   * Requeued today, offered tomorrow.
   *
   * Re-handing a row that came back from `failed` UPDATES handedOutAt rather
   * than adding a second row, so handedOutToday never moves and the cap never
   * engages. Without the handedOutAt predicate in claim(), an account whose
   * queue is shallower than its cap could pull the same handles back forever
   * inside one day at full speed -- which is exactly the rate limiting the cap
   * exists to impose.
   */
  it('does not re-offer a failed follow until the next day', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 3);

    const claimed = await targets.claim(account.id, 3);
    for (const t of claimed.targets) await targets.report(account.id, t.handle, 'failed');
    expect(
      await prisma.assignment.count({ where: { accountId: account.id, state: 'queued' } }),
    ).toBe(3);

    // All three are queued again, and none may come back out today.
    expect((await targets.claim(account.id, 10)).targets).toEqual([]);
    expect(await targets.handedOutToday(account.id)).toBe(3);

    // Age yesterday's attempt and they become available again, cap intact.
    await prisma.assignment.updateMany({
      where: { accountId: account.id },
      data: { handedOutAt: new Date(Date.now() - 36 * 3_600_000) },
    });
    expect(await targets.handedOutToday(account.id)).toBe(0);
    expect((await targets.claim(account.id, 10)).targets).toHaveLength(3);
  });

  it('treats skipped as terminal', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 2);
    const [first] = (await targets.claim(account.id, 2)).targets;

    await targets.report(account.id, first.handle, 'skipped');

    const row = await prisma.assignment.findFirst({
      where: { person: { personalityId: client.personality.id, handle: first.handle } },
    });
    expect(row!.state).toBe('skipped');
    expect((await targets.claim(account.id, 10)).targets.map((r) => r.handle)).not.toContain(
      first.handle,
    );
  });

  it('refuses a report from a sibling account of the same personality', async () => {
    const client = await makeClient({ accounts: 2, dailyCap: 50 });
    const [mine, sibling] = client.personality.accounts;
    await queueTargets(client.personality.id, mine.id, 3);
    const [first] = (await targets.claim(mine.id, 1)).targets;

    await expect(targets.report(sibling.id, first.handle, 'followed')).rejects.toThrow(
      ForbiddenException,
    );

    const row = await prisma.assignment.findFirst({
      where: { person: { personalityId: client.personality.id, handle: first.handle } },
    });
    expect(row!.state).toBe('handed_out');
    expect(row!.accountId).toBe(mine.id);
  });

  it('refuses a handle the personality has never seen', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await expect(targets.report(account.id, 'never_seen_here', 'followed')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses a handle that belongs to another personality', async () => {
    const mine = await makeClient({ accounts: 1, dailyCap: 50 });
    const other = await makeClient({ accounts: 1, dailyCap: 50 });
    const otherAccount = other.personality.accounts[0];
    const handles = await queueTargets(other.personality.id, otherAccount.id, 1);

    // The same handle string exists, but not in this personality's ledger, and
    // the lookup is scoped by (personalityId, handle) rather than by handle.
    await expect(
      targets.report(mine.personality.accounts[0].id, handles[0], 'followed'),
    ).rejects.toThrow(NotFoundException);
  });
});
