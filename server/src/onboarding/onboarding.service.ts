/**
 * Seeding a new account, when Snapchat shows it nobody.
 *
 * A fresh account has no Quick Add roster, so the ordinary loop has nothing to
 * photograph, nothing to extract and nothing to queue: it asks for targets and
 * is handed zero, forever. This fills that gap by giving the account a list of
 * handles to SEARCH by name -- the one way in that works on a fresh account,
 * proven on the device on 2026-08-19.
 *
 * WHERE THE HANDLES COME FROM, IN ORDER
 *
 *   1. the imported pool   what the operator pasted in. First because it is the
 *                          only source they chose deliberately.
 *   2. another personality  people this client already knows are worth having,
 *                          taken from a persona that is not this one.
 *   3. this personality     whatever it holds that nobody was ever given.
 *
 * Only high-confidence people are borrowed at steps 2 and 3. A new account is
 * the most fragile thing on the box and the first fifty adds set what Snapchat
 * thinks it is for; spending them on someone the model was unsure about is the
 * one mistake here that cannot be undone.
 *
 * WHAT IT ACTUALLY WRITES
 *
 * Person rows in THIS personality, source `manual`, queued to THIS account --
 * which is to say, exactly what a manual attach writes. That is deliberate:
 * everything downstream then works unchanged. The daily cap meters them because
 * they are ordinary assignments, `report()` records them because they are
 * ordinary rows, and the dedupe holds because a handle this personality already
 * has is never seeded twice.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * How many searched adds an account needs before it stops being new.
 *
 * Fifty, because that is roughly where Snapchat starts suggesting people of its
 * own and the ordinary roster walk takes over. It is a floor, not a quota: an
 * account whose roster fills sooner simply stops asking, because the claim only
 * reaches this code when the account has nothing queued of its own.
 */
export const ONBOARD_TARGET = 50;

/**
 * Which pair of caps meters this account, given how far into onboarding it is.
 *
 * ONE definition, because there are three places that turn a cap into a number
 * -- the claim that enforces it, remainingToday(), and the account row the
 * dashboard and the agent both read -- and they must not be able to disagree.
 * An agent told it has budget by one of them and refused by another spends a
 * capture, a montage and a vision call to discover the difference.
 *
 * REPLACES rather than stacks: while onboarding, the ordinary pair does not
 * apply at all. Stacking would make the tighter of two unrelated numbers win,
 * which is precisely the "one number answering two questions" this exists to
 * undo.
 */
export function effectiveCaps(
  onboardedCount: number,
  caps: {
    dailyCap: number;
    sessionCap: number;
    onboardingDailyCap: number;
    onboardingSessionCap: number;
  },
): { onboarding: boolean; dailyCap: number; sessionCap: number } {
  const onboarding = onboardedCount < ONBOARD_TARGET;
  return {
    onboarding,
    dailyCap: onboarding ? caps.onboardingDailyCap : caps.dailyCap,
    sessionCap: onboarding ? caps.onboardingSessionCap : caps.sessionCap,
  };
}

@Injectable()
export class OnboardingService {
  private readonly log = new Logger(OnboardingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Is this account still being seeded? */
  async isOnboarding(accountId: string): Promise<boolean> {
    const a = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { onboardedCount: true },
    });
    return !!a && a.onboardedCount < ONBOARD_TARGET;
  }

  /**
   * Give this account up to `want` people to search for. -> how many it got.
   *
   * Called only when the account has nothing queued of its own, so it cannot
   * pull an established account off its roster. Bounded by what is left of the
   * onboarding target as well as by `want`: an account four adds from done is
   * given four, not fifty.
   */
  async seed(accountId: string, want: number): Promise<number> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        label: true,
        onboardedCount: true,
        personalityId: true,
        personality: { select: { clientId: true } },
      },
    });
    if (!account) throw new NotFoundException('account not found');

    const room = Math.min(want, ONBOARD_TARGET - account.onboardedCount);
    if (room <= 0) return 0;

    const clientId = account.personality.clientId;
    const held = new Set(
      (
        await this.prisma.person.findMany({
          where: { personalityId: account.personalityId },
          select: { handle: true },
        })
      ).map((p) => p.handle),
    );

    // 1. the imported pool
    const pool = await this.prisma.onboardingHandle.findMany({
      where: { clientId, usedAt: null },
      orderBy: { createdAt: 'asc' },
      take: room * 2, // room to skip the ones this personality already holds
      select: { id: true, handle: true },
    });
    const takenFromPool: string[] = [];
    const handles: string[] = [];
    for (const row of pool) {
      if (handles.length >= room) break;
      if (held.has(row.handle)) continue;
      handles.push(row.handle);
      held.add(row.handle);
      takenFromPool.push(row.id);
    }

    // 2. another personality of the same client, then 3. this one. Both are
    //    high-confidence only, and both exclude anyone already followed --
    //    borrowing a name is fine, following one human twice is not.
    for (const scope of ['others', 'own'] as const) {
      if (handles.length >= room) break;
      const borrowed = await this.prisma.person.findMany({
        where: {
          nationalityConf: 'high',
          personality:
            scope === 'others'
              ? { clientId, id: { not: account.personalityId } }
              : { id: account.personalityId },
          // Never anybody already spoken for. Borrowing a NAME from another
          // persona is the point; borrowing a person somebody is working, or
          // has followed, would put one human in two of our ledgers.
          assignment: { is: null },
          handle: { notIn: [...held] },
        },
        orderBy: { createdAt: 'desc' },
        take: room - handles.length,
        select: { handle: true },
      });
      for (const p of borrowed) {
        if (handles.length >= room) break;
        if (held.has(p.handle)) continue;
        handles.push(p.handle);
        held.add(p.handle);
      }
    }

    if (handles.length === 0) return 0;

    // Written exactly as a manual attach writes: a typed-in handle carries no
    // avatar and no country, so `manual` is what stops the filter -- which
    // judges on precisely those -- from dropping every one of them.
    await this.prisma.person.createMany({
      data: handles.map((handle) => ({
        personalityId: account.personalityId,
        handle,
        displayName: '',
        source: 'manual' as const,
      })),
      skipDuplicates: true,
    });
    const people = await this.prisma.person.findMany({
      where: { personalityId: account.personalityId, handle: { in: handles } },
      select: { id: true },
    });
    const { count } = await this.prisma.assignment.createMany({
      data: people.map((p) => ({
        personId: p.id,
        accountId,
        state: 'queued' as const,
        reason: 'onboarding: searched by name, this account has no roster yet',
      })),
      skipDuplicates: true,
    });

    if (takenFromPool.length) {
      await this.prisma.onboardingHandle.updateMany({
        where: { id: { in: takenFromPool } },
        data: { usedByAccountId: accountId, usedAt: new Date() },
      });
    }

    this.log.log(
      `onboarding ${account.label}: seeded ${count} handle(s) ` +
        `(${takenFromPool.length} from the imported pool), ` +
        `${account.onboardedCount}/${ONBOARD_TARGET} added so far`,
    );
    return count;
  }
}
