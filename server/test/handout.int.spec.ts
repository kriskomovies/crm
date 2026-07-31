/**
 * The metered handout and the result callback.
 *
 * GET /v1/accounts/:id/targets is not a read: it claims rows and spends the
 * daily cap. Both of its correctness properties -- "never the same person
 * twice" and "never more than the cap" -- are only observable against a real
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
    expect(first).toHaveLength(7);
    expect(await targets.remainingToday(account.id)).toBe(0);

    const second = await targets.claim(account.id, 100);
    expect(second).toEqual([]);

    // The other 13 stay queued for tomorrow rather than being dropped.
    expect(
      await prisma.assignment.count({ where: { accountId: account.id, state: 'queued' } }),
    ).toBe(13);
    expect(
      await prisma.assignment.count({ where: { accountId: account.id, state: 'handed_out' } }),
    ).toBe(7);
  });

  it('claims the oldest queued rows first', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    const handles = await queueTargets(client.personality.id, account.id, 10);

    const claimed = await targets.claim(account.id, 4);
    expect(claimed.map((c) => c.handle)).toEqual(handles.slice(0, 4));
  });

  it('hands out nothing for a disabled account', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 5);
    await prisma.account.update({ where: { id: account.id }, data: { enabled: false } });

    expect(await targets.remainingToday(account.id)).toBe(0);
    expect(await targets.claim(account.id, 10)).toEqual([]);
  });

  it('rejects an unknown account rather than returning an empty page', async () => {
    await expect(targets.remainingToday('no-such-account')).rejects.toThrow(NotFoundException);
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

    const handles = batches.flatMap((b) => b.map((r) => r.handle));
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

    const handles = [...a.map((r) => r.handle), ...b.map((r) => r.handle)];
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
    const [first] = await targets.claim(account.id, 3);

    await targets.report(account.id, first.handle, 'followed', 'done');

    const row = await prisma.assignment.findFirst({
      where: { person: { personalityId: client.personality.id, handle: first.handle } },
    });
    expect(row!.state).toBe('followed');
    expect(row!.resultAt).not.toBeNull();
    expect(row!.note).toBe('done');

    // Terminal means it never comes back round: a further claim cannot see it.
    const again = await targets.claim(account.id, 10);
    expect(again.map((r) => r.handle)).not.toContain(first.handle);
  });

  it('returns a failed follow to the queue, keeping it against today s cap', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 3);
    const claimed = await targets.claim(account.id, 3);
    const victim = claimed[1].handle;

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
    for (const t of claimed) await targets.report(account.id, t.handle, 'failed');
    expect(
      await prisma.assignment.count({ where: { accountId: account.id, state: 'queued' } }),
    ).toBe(3);

    // All three are queued again, and none may come back out today.
    expect(await targets.claim(account.id, 10)).toEqual([]);
    expect(await targets.handedOutToday(account.id)).toBe(3);

    // Age yesterday's attempt and they become available again, cap intact.
    await prisma.assignment.updateMany({
      where: { accountId: account.id },
      data: { handedOutAt: new Date(Date.now() - 36 * 3_600_000) },
    });
    expect(await targets.handedOutToday(account.id)).toBe(0);
    expect(await targets.claim(account.id, 10)).toHaveLength(3);
  });

  it('treats skipped as terminal', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 2);
    const [first] = await targets.claim(account.id, 2);

    await targets.report(account.id, first.handle, 'skipped');

    const row = await prisma.assignment.findFirst({
      where: { person: { personalityId: client.personality.id, handle: first.handle } },
    });
    expect(row!.state).toBe('skipped');
    expect((await targets.claim(account.id, 10)).map((r) => r.handle)).not.toContain(first.handle);
  });

  it('refuses a report from a sibling account of the same personality', async () => {
    const client = await makeClient({ accounts: 2, dailyCap: 50 });
    const [mine, sibling] = client.personality.accounts;
    await queueTargets(client.personality.id, mine.id, 3);
    const [first] = await targets.claim(mine.id, 1);

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
