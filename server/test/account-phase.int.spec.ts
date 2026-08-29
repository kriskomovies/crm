/**
 * The three lives of an account, and the one that must hand out nothing.
 *
 * A bought account arrives carrying the previous owner's friends, conversations
 * and synced contacts. Until a machine has wiped all three it is in `cleanup`,
 * and seeding it would be actively wrong rather than merely early: contact sync
 * is still on, so Snapchat is still suggesting the very people about to be
 * deleted, and every row handed out spends a cap slot on a roster that is about
 * to change underneath it.
 *
 * So the assertions here are mostly about refusal, and about the one transition
 * being safe to repeat -- a machine that retried after a dropped reply must not
 * send an account backwards.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { dropFixtures, makeClient, prisma, queueTargets, targets } from './fixtures';

afterEach(dropFixtures);
afterAll(() => prisma.$disconnect());

async function setPhase(accountId: string, phase: 'cleanup' | 'seeding' | 'established') {
  await prisma.account.update({ where: { id: accountId }, data: { phase } });
}

describe('an account being wiped is handed nothing', () => {
  it('claims no targets and spends no cap while in cleanup', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);
    await setPhase(account.id, 'cleanup');

    const claimed = await targets.claim(account.id, 25);

    expect(claimed.targets).toEqual([]);
    // The refusal is before the charge, not after it: a slot spent here is a
    // slot spent on a roster that is about to be deleted.
    expect(await targets.remainingToday(account.id)).toBe(50);
    expect(
      await prisma.assignment.count({
        where: { accountId: account.id, handedOutAt: { not: null } },
      }),
    ).toBe(0);
  });

  it('hands out normally the moment the wipe is reported', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50, onboardingDailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);
    await setPhase(account.id, 'cleanup');

    expect((await targets.claim(account.id, 5)).targets).toEqual([]);

    expect(await targets.markCleaned(account.id)).toBe('seeding');
    expect((await targets.claim(account.id, 5)).targets).toHaveLength(5);
  });
});

describe('the cleanup transition', () => {
  it('is idempotent, so a retried report cannot send an account backwards', async () => {
    const client = await makeClient({ accounts: 1 });
    const account = client.personality.accounts[0];
    await setPhase(account.id, 'cleanup');

    expect(await targets.markCleaned(account.id)).toBe('seeding');
    const row = await prisma.account.findUnique({
      where: { id: account.id },
      select: { cleanedAt: true },
    });
    expect(row!.cleanedAt).not.toBeNull();

    // Second report: still seeding, and the timestamp is not moved -- when the
    // wipe happened is a fact, not a running total.
    expect(await targets.markCleaned(account.id)).toBe('seeding');
    const again = await prisma.account.findUnique({
      where: { id: account.id },
      select: { cleanedAt: true },
    });
    expect(again!.cleanedAt!.getTime()).toBe(row!.cleanedAt!.getTime());
  });

  it('never drags an established account back into seeding', async () => {
    // The failure this guards: an operator or a stale machine reporting a wipe
    // for an account that has been working for a fortnight.
    const client = await makeClient({ accounts: 1 });
    const account = client.personality.accounts[0];
    await setPhase(account.id, 'established');

    expect(await targets.markCleaned(account.id)).toBe('established');
  });

  it('refuses an account that does not exist rather than inventing one', async () => {
    await expect(targets.markCleaned('no-such-account')).rejects.toThrow();
  });
});

describe('phase is served, because the agent acts on it', () => {
  it('answers the phase the account is actually in', async () => {
    const client = await makeClient({ accounts: 1 });
    const account = client.personality.accounts[0];

    await setPhase(account.id, 'cleanup');
    expect(await targets.phaseOf(account.id)).toBe('cleanup');

    await targets.markCleaned(account.id);
    expect(await targets.phaseOf(account.id)).toBe('seeding');
  });
});
