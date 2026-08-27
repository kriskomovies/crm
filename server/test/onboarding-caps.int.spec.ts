/**
 * The caps that meter an account while it is still being ONBOARDED.
 *
 * An onboarding account -- one short of ONBOARD_TARGET searched adds -- is not
 * doing the same work as an established one. It reaches people by typing exact
 * usernames into Snapchat's own search, which is a stronger signal than tapping
 * a suggestion the app offered, and it does it on the youngest account on the
 * box. It also has the opposite pressure on it: it earns nothing until it is
 * seeded. One pair of numbers could not answer both questions, so there is a
 * second pair, and these tests pin the three things that could go wrong with it:
 *
 *   - the onboarding pair REPLACES the ordinary pair, never stacks with it
 *   - an established account is untouched by it
 *   - the switch happens exactly at ONBOARD_TARGET, read from the same locked
 *     row as the caps
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { dropFixtures, makeClient, prisma, queueTargets, targets } from './fixtures';
import { ONBOARD_TARGET } from '../src/onboarding/onboarding.service';

afterEach(dropFixtures);
afterAll(() => prisma.$disconnect());

/** Mark an account as having finished onboarding, without touching its ledger. */
async function graduate(accountId: string) {
  await prisma.account.update({
    where: { id: accountId },
    data: { onboardedCount: ONBOARD_TARGET },
  });
}

describe('an onboarding account is metered by the onboarding caps', () => {
  it('is bounded by onboardingSessionCap, not by the ordinary session cap', async () => {
    // The ordinary caps are wide; the onboarding pair is what must bind.
    const client = await makeClient({
      accounts: 1,
      onboarding: true,
      dailyCap: 500,
      sessionCap: 500,
      onboardingDailyCap: 40,
      onboardingSessionCap: 10,
    });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 60);

    const claimed = await targets.claim(account.id, 25);

    expect(claimed.targets).toHaveLength(10);
    expect(await targets.remainingToday(account.id)).toBe(30); // 40 - 10
  });

  it('stops at onboardingDailyCap across a whole day', async () => {
    // The window is wide so only the DAILY onboarding cap can bind here.
    const client = await makeClient({
      accounts: 1,
      onboarding: true,
      dailyCap: 500,
      sessionCap: 500,
      onboardingDailyCap: 12,
      onboardingSessionCap: 500,
    });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 60);

    const first = await targets.claim(account.id, 25);
    expect(first.targets).toHaveLength(12);

    const second = await targets.claim(account.id, 25);
    expect(second.targets).toEqual([]);
    expect(await targets.remainingToday(account.id)).toBe(0);
  });

  it('REPLACES the ordinary caps rather than stacking with them', async () => {
    // The ordinary cap is the TIGHTER of the two here. If the two stacked -- if
    // the claim took the minimum of both pairs -- this would hand out 3. It must
    // hand out 20, because while onboarding the ordinary pair does not apply.
    const client = await makeClient({
      accounts: 1,
      onboarding: true,
      dailyCap: 3,
      sessionCap: 3,
      onboardingDailyCap: 40,
      onboardingSessionCap: 20,
    });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 60);

    const claimed = await targets.claim(account.id, 25);

    expect(claimed.targets).toHaveLength(20);
  });
});

describe('an established account is untouched by them', () => {
  it('goes back to the ordinary caps once it has finished onboarding', async () => {
    const client = await makeClient({
      accounts: 1,
      onboarding: true,
      dailyCap: 7,
      sessionCap: 7,
      onboardingDailyCap: 40,
      onboardingSessionCap: 40,
    });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 60);

    await graduate(account.id);
    const claimed = await targets.claim(account.id, 25);

    expect(claimed.targets).toHaveLength(7);
  });

  it('switches exactly at ONBOARD_TARGET, not one short of it', async () => {
    // One add short of the target is still onboarding. This is the boundary the
    // whole feature turns on, so it is asserted rather than assumed.
    const client = await makeClient({
      accounts: 1,
      onboarding: true,
      dailyCap: 2,
      sessionCap: 2,
      onboardingDailyCap: 40,
      onboardingSessionCap: 9,
    });
    const account = client.personality.accounts[0];
    await queueTargets(client.personality.id, account.id, 60);

    await prisma.account.update({
      where: { id: account.id },
      data: { onboardedCount: ONBOARD_TARGET - 1 },
    });

    const claimed = await targets.claim(account.id, 25);
    expect(claimed.targets).toHaveLength(9);
  });
});
