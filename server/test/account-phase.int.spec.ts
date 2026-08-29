/**
 * The ladder an account climbs once, and never descends.
 *
 *   cleanup_contacts -> cleanup_chats -> cleanup_friends -> seeding -> established
 *
 * A bought account arrives carrying the previous owner's friends, conversations
 * and synced contacts. Until a machine has wiped all three it is being cleaned,
 * and seeding it would be actively wrong rather than merely early: contact sync
 * is still on, so Snapchat is still suggesting the very people about to be
 * deleted, and every row handed out spends a cap slot on a roster that is about
 * to change underneath it.
 *
 * So most of what is asserted here is REFUSAL, on both of the endpoints that
 * hand work out -- the claim and the roster -- and that the one direction of
 * travel is safe to repeat: a machine that retried after a dropped reply must
 * not move an account, forwards or back.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { dropFixtures, makeClient, prisma, queueTargets, roster, targets } from './fixtures';
import { ONBOARD_TARGET, PHASES } from '../src/onboarding/onboarding.service';

afterEach(dropFixtures);
afterAll(() => prisma.$disconnect());

type Phase = (typeof PHASES)[number];

async function setPhase(accountId: string, phase: Phase) {
  await prisma.account.update({ where: { id: accountId }, data: { phase } });
}

const phaseOf = async (accountId: string) =>
  (await prisma.account.findUnique({ where: { id: accountId }, select: { phase: true } }))!.phase;

const CLEANUP: Phase[] = ['cleanup_contacts', 'cleanup_chats', 'cleanup_friends'];

describe('an account being wiped is handed nothing', () => {
  // Every cleanup rung, not just the first: the gate asks whether a phase may
  // receive rather than whether it is the first rung, and a rung that leaked
  // would be an un-wiped account being given people to add.
  it.each(CLEANUP)('claims no targets and spends no cap in %s', async (phase) => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);
    await setPhase(account.id, phase);

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

  // The hole this was written for. POST /targets/roster is the endpoint the
  // cycle actually uses for the roster walk, and it had no phase gate at all --
  // it read `enabled` and the caps and nothing else. So an un-wiped account
  // posting the PREVIOUS OWNER'S Quick Add was answered `add` and charged a cap
  // slot per row, while the claim beside it was correctly refusing.
  it.each(CLEANUP)('is told to leave its whole roster alone in %s', async (phase) => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    const handles = await queueTargets(client.personality.id, account.id, 5);
    await setPhase(account.id, phase);

    const answer = await roster.decide(account.id, handles);

    expect(answer.verdicts.map((v) => v.do)).toEqual(handles.map(() => 'leave'));
    // Not one 'reject' among them. A reject is an irreversible Snapchat hide,
    // and hiding the last owner's roster is a decision nobody has made yet.
    expect(answer.verdicts.some((v) => v.do === 'reject')).toBe(false);
    expect(answer.remainingToday).toBe(0);
    expect(
      await prisma.assignment.count({
        where: { accountId: account.id, handedOutAt: { not: null } },
      }),
    ).toBe(0);
  });
});

describe('climbing the ladder', () => {
  it('advances one rung per reported step, in order', async () => {
    const client = await makeClient({ accounts: 1 });
    const account = client.personality.accounts[0];
    await setPhase(account.id, 'cleanup_contacts');

    expect(await targets.reportCleanupStep(account.id, 'contacts')).toBe('cleanup_chats');
    expect(await targets.reportCleanupStep(account.id, 'chats')).toBe('cleanup_friends');
    expect(await targets.reportCleanupStep(account.id, 'friends')).toBe('seeding');
  });

  it('hands out normally the moment the last step is reported', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50, onboardingDailyCap: 50 });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 40);
    await setPhase(account.id, 'cleanup_friends');

    expect((await targets.claim(account.id, 5)).targets).toEqual([]);

    expect(await targets.reportCleanupStep(account.id, 'friends')).toBe('seeding');
    expect((await targets.claim(account.id, 5)).targets).toHaveLength(5);
  });

  it('lets an agent that wiped everything in one visit say so with no step', async () => {
    // The bodyless call, which is also what every machine speaking the older
    // one-transition version of this endpoint sends.
    const client = await makeClient({ accounts: 1 });
    const account = client.personality.accounts[0];
    await setPhase(account.id, 'cleanup_contacts');

    expect(await targets.reportCleanupStep(account.id)).toBe('seeding');
  });

  it('stamps cleanedAt once, on arrival at seeding and not on each rung', async () => {
    const client = await makeClient({ accounts: 1 });
    const account = client.personality.accounts[0];
    await setPhase(account.id, 'cleanup_contacts');

    await targets.reportCleanupStep(account.id, 'contacts');
    const mid = await prisma.account.findUnique({
      where: { id: account.id },
      select: { cleanedAt: true },
    });
    expect(mid!.cleanedAt).toBeNull();

    await targets.reportCleanupStep(account.id, 'friends');
    const done = await prisma.account.findUnique({
      where: { id: account.id },
      select: { cleanedAt: true },
    });
    expect(done!.cleanedAt).not.toBeNull();
  });
});

describe('the ladder only goes up', () => {
  it('ignores a step already passed, so a retried report changes nothing', async () => {
    const client = await makeClient({ accounts: 1 });
    const account = client.personality.accounts[0];
    await setPhase(account.id, 'cleanup_contacts');

    expect(await targets.reportCleanupStep(account.id, 'friends')).toBe('seeding');
    const first = await prisma.account.findUnique({
      where: { id: account.id },
      select: { cleanedAt: true },
    });

    // Same report again, and an EARLIER one arriving late behind it -- the
    // shape a machine retrying two dropped replies out of order produces.
    expect(await targets.reportCleanupStep(account.id, 'friends')).toBe('seeding');
    expect(await targets.reportCleanupStep(account.id, 'contacts')).toBe('seeding');

    const again = await prisma.account.findUnique({
      where: { id: account.id },
      select: { cleanedAt: true },
    });
    // When the wipe happened is a fact, not a running total.
    expect(again!.cleanedAt!.getTime()).toBe(first!.cleanedAt!.getTime());
  });

  it('never drags an established account back down', async () => {
    // The failure this guards: an operator or a stale machine reporting a wipe
    // for an account that has been working for a fortnight.
    const client = await makeClient({ accounts: 1 });
    const account = client.personality.accounts[0];
    await setPhase(account.id, 'established');

    expect(await targets.reportCleanupStep(account.id, 'contacts')).toBe('established');
    expect(await targets.reportCleanupStep(account.id)).toBe('established');
  });

  it('refuses an account that does not exist rather than inventing one', async () => {
    await expect(targets.reportCleanupStep('no-such-account')).rejects.toThrow();
  });
});

describe('the top rung is reachable', () => {
  it('turns seeding into established on the add that reaches the target', async () => {
    // Before this, nothing in the codebase ever WROTE 'established': an account
    // seeded to fifty sat on 'seeding' forever while effectiveCaps -- which
    // reads onboardedCount, not phase -- had long since begun metering it as
    // established. Two ladders, disagreeing, and the console showed the wrong one.
    const client = await makeClient({
      accounts: 1,
      onboarding: true,
      onboardingDailyCap: 500,
      onboardingSessionCap: 500,
    });
    const account = client.personality.accounts[0];
    await prisma.account.update({
      where: { id: account.id },
      data: { phase: 'seeding', onboardedCount: ONBOARD_TARGET - 1 },
    });
    const [handle] = await queueTargets(client.personality.id, account.id, 1);
    // onboardedCount counts SEARCHED adds, which is what a `manual` row is --
    // nothing else creates one, and report() only increments on that source.
    await prisma.person.updateMany({
      where: { personalityId: client.personality.id, handle },
      data: { source: 'manual' },
    });

    await targets.claim(account.id, 1);
    await targets.report(account.id, handle, 'followed');

    expect(await phaseOf(account.id)).toBe('established');
  });

  it('leaves an account short of the target still seeding', async () => {
    const client = await makeClient({
      accounts: 1,
      onboarding: true,
      onboardingDailyCap: 500,
      onboardingSessionCap: 500,
    });
    const account = client.personality.accounts[0];
    await prisma.account.update({
      where: { id: account.id },
      data: { phase: 'seeding', onboardedCount: ONBOARD_TARGET - 2 },
    });
    const [handle] = await queueTargets(client.personality.id, account.id, 1);
    // onboardedCount counts SEARCHED adds, which is what a `manual` row is --
    // nothing else creates one, and report() only increments on that source.
    await prisma.person.updateMany({
      where: { personalityId: client.personality.id, handle },
      data: { source: 'manual' },
    });

    await targets.claim(account.id, 1);
    await targets.report(account.id, handle, 'followed');

    expect(await phaseOf(account.id)).toBe('seeding');
  });
});

describe('phase is served, because both the agent and the console act on it', () => {
  it('answers the phase the account is actually in', async () => {
    const client = await makeClient({ accounts: 1 });
    const account = client.personality.accounts[0];

    await setPhase(account.id, 'cleanup_chats');
    expect(await targets.phaseOf(account.id)).toBe('cleanup_chats');

    await targets.reportCleanupStep(account.id);
    expect(await targets.phaseOf(account.id)).toBe('seeding');
  });

  it('answers an unknown account with the FIRST rung, not the last', async () => {
    // A gate fails closed. "I cannot tell where this account is" must land on
    // the side that hands out nothing; the previous default here was
    // 'established', the one answer guaranteed to be unsafe.
    expect(await targets.phaseOf('no-such-account')).toBe(PHASES[0]);
  });
});
