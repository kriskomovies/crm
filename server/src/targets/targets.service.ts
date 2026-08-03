/**
 * The metered handout: "who should this account follow next".
 *
 * This is the endpoint the whole product exists to serve, and it is the reason
 * delivery is a poll rather than a push. A daily cap can only be enforced if
 * the server controls the timing of handout; pushing a batch hands over
 * everything at once and the cap becomes advisory.
 *
 * Concurrency matters here. The same account may poll from two emulator
 * processes, or retry after a timeout while the first request is still in
 * flight. Claiming rows with a plain SELECT-then-UPDATE would hand the same
 * person to both callers and silently burn a follow slot, so the claim is a
 * single statement using FOR UPDATE SKIP LOCKED -- the standard work-queue
 * pattern, and the only version of this that is correct under load.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

export interface TargetRow {
  handle: string;
  displayName: string;
  nationality: string | null;
  reason: string | null;
}

/** Results an account may report back for a handed-out target. */
export type FollowResult = 'followed' | 'failed' | 'skipped';

@Injectable()
export class TargetsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Targets already handed to this account since local midnight. Counting
   * handedOutAt rather than a counter column means a crashed worker or a
   * rolled-back transaction cannot leak cap.
   */
  async handedOutToday(accountId: string): Promise<number> {
    const since = startOfToday();
    return this.prisma.assignment.count({
      where: { accountId, handedOutAt: { gte: since } },
    });
  }

  async remainingToday(accountId: string): Promise<number> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        enabled: true,
        personality: { select: { client: { select: { dailyCapPerAccount: true } } } },
      },
    });
    if (!account) throw new NotFoundException('account not found');
    if (!account.enabled) return 0;
    const cap = account.personality.client.dailyCapPerAccount;
    return Math.max(0, cap - (await this.handedOutToday(accountId)));
  }

  /** Seconds an agent waits between follows. Served, never acted on here. */
  async paceSeconds(accountId: string): Promise<number> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { personality: { select: { client: { select: { followPaceSeconds: true } } } } },
    });
    if (!account) throw new NotFoundException('account not found');
    return account.personality.client.followPaceSeconds;
  }

  /**
   * Claim up to `limit` queued targets, capped by what is left today.
   *
   * Returns fewer rows than asked for -- often zero -- and that is normal, not
   * an error: it means the cap is spent or the queue is empty. Clients should
   * back off rather than retry immediately.
   *
   * Wrapped in a transaction that takes a row lock on the account first. SKIP
   * LOCKED keeps the two callers of an overlapping poll off each other's rows,
   * but it says nothing about how many rows each may take: reading "handed out
   * today" and claiming against it as two statements let both polls see the
   * same zero and both take a full cap, so twice the cap went out with no row
   * handed to anyone twice. That is the failure the cap exists to prevent --
   * the emulator is rate-limited exactly as if there were no cap -- and two
   * processes on one account, or a retry over a request still in flight, is the
   * documented normal case here.
   *
   * The lock serialises claims for THIS account only; other accounts are
   * untouched, and the count still comes from handedOutAt rather than a counter
   * column, so a crashed worker or a rolled-back transaction cannot leak cap.
   */
  async claim(accountId: string, limit: number): Promise<TargetRow[]> {
    const since = utcLiteral(startOfToday());
    return this.prisma.$transaction(async (tx) => {
      // FOR UPDATE OF a, not a bare FOR UPDATE: the cap now comes from the
      // client row, and locking that too would serialise the claims of every
      // account the client owns against each other. The lock this needs is on
      // the one account whose budget is about to be counted and spent.
      const [account] = await tx.$queryRaw<{ dailyCap: number; enabled: boolean }[]>`
        SELECT c."dailyCapPerAccount" AS "dailyCap", a.enabled
        FROM accounts a
        JOIN personalities p ON p.id = a."personalityId"
        JOIN clients c ON c.id = p."clientId"
        WHERE a.id = ${accountId}
        FOR UPDATE OF a
      `;
      if (!account) throw new NotFoundException('account not found');
      if (!account.enabled) return [];

      const [used] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM assignments
        WHERE "accountId" = ${accountId}
          AND "handedOutAt" >= ${since}::timestamp
      `;
      const take = Math.max(0, Math.min(limit, account.dailyCap - used.n));
      if (take === 0) return [];

      // One statement: pick the oldest queued rows for this account, skip any a
      // concurrent poll is already holding, flip them to handed_out, and return
      // them joined to the person. Nothing between the select and the update.
      return tx.$queryRaw<
        { handle: string; displayName: string; nationality: string | null; reason: string | null }[]
      >`
      WITH claimed AS (
        SELECT a.id
        FROM assignments a
        -- No ::uuid cast: Prisma's String @default(uuid()) maps to TEXT, not
        -- the native uuid type, so casting here fails with "operator does not
        -- exist: text = uuid".
        WHERE a."accountId" = ${accountId}
          AND a.state = 'queued'
          -- A 'failed' report requeues the row but keeps handedOutAt so the
          -- attempt still counts. Re-handing a row that is already counted does
          -- not move the counter, so without this an account that reports
          -- failure in a loop pulls the same handle back forever at full speed
          -- and the daily cap -- the one thing protecting the Snapchat account
          -- from rate limiting -- never engages. It waits for tomorrow instead.
          AND (a."handedOutAt" IS NULL OR a."handedOutAt" < ${since}::timestamp)
        -- NEWEST FIRST, and this is the whole efficiency of the product.
        --
        -- A handle can only be followed while the person is still on the
        -- emulator's Quick Add roster, and that roster is re-rolled every time
        -- Snapchat restarts -- which the agent does deliberately after each
        -- batch, because it is the only thing that produces new people. So a
        -- row queued from an older sheet is not merely stale, it is gone from
        -- the device and cannot be followed at all.
        --
        -- Measured on a live account at cap 50: oldest-first spent 18 of the
        -- 50 on orphans from the previous sheet, every one of which missed, for
        -- 32 follows. It also took 31 minutes instead of 11, because a miss
        -- scans twelve pages and rewinds before giving up.
        --
        -- Nothing is stranded that the old order preserved: a skip is terminal
        -- (see report()), so those rows were never coming back either way. This
        -- only stops metered cap being spent on rows already guaranteed to
        -- fail. The consequence to know about is that a handle left behind by a
        -- burst of fresh sheets may never be handed out -- which is correct,
        -- and makes the queued count a count of the ledger rather than of work
        -- that is still reachable.
        --
        -- id breaks the tie: allocate() writes a whole sheet in one createMany,
        -- so every row from one sheet shares a createdAt, and the sort has to
        -- be total or "the newest 25" is not a repeatable set.
        ORDER BY a."createdAt" DESC, a.id DESC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE assignments a
      -- NOT NOW(). handedOutAt is timestamp WITHOUT time zone and every
      -- Prisma write puts UTC in it, but NOW() is timestamptz and the implicit
      -- cast renders it in the session TimeZone -- Europe/Kiev on this box.
      -- Measured: rows landed three hours ahead of the instant
      -- handedOutToday() compares against, so a handout from the last three
      -- hours of yesterday was still counted against today's cap.
      SET state = 'handed_out', "handedOutAt" = (NOW() AT TIME ZONE 'UTC')
      FROM claimed c, people p
      WHERE a.id = c.id AND p.id = a."personId"
      RETURNING p.handle AS handle,
                p."displayName" AS "displayName",
                p.nationality AS nationality,
                a.reason AS reason
      `;
    });
  }

  /**
   * Record what happened. A failed follow returns to the queue so it is retried
   * rather than lost, but not today -- see the handedOutAt predicate in claim().
   * `skipped` is terminal because the account decided against it and
   * re-offering would loop.
   */
  async report(
    accountId: string,
    handle: string,
    result: FollowResult,
    note?: string,
  ): Promise<void> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { personalityId: true },
    });
    if (!account) throw new NotFoundException('account not found');

    const person = await this.prisma.person.findUnique({
      where: { personalityId_handle: { personalityId: account.personalityId, handle } },
      select: { id: true },
    });
    if (!person) throw new NotFoundException('unknown handle for this personality');

    const assignment = await this.prisma.assignment.findUnique({
      where: { personId: person.id },
    });
    if (!assignment) throw new NotFoundException('no assignment for that person');
    // Reporting on a target belonging to a sibling account would corrupt the
    // ledger, so ownership is checked rather than assumed.
    if (assignment.accountId !== accountId) {
      throw new ForbiddenException('that target belongs to another account');
    }

    await this.prisma.assignment.update({
      where: { id: assignment.id },
      data: {
        // A failure goes back to queued, but keeps handedOutAt so it still
        // counts against today's cap -- the follow attempt was really made.
        state: result === 'failed' ? 'queued' : result,
        resultAt: new Date(),
        note: note?.slice(0, 500),
      },
    });
  }

  /**
   * The dedupe ledger for a personality: everyone taken, and by which account.
   *
   * Cursor, not skip. The caller asks for one row more than it means to show
   * and turns the overshoot into nextCursor; createdAt alone is not unique, so
   * id makes the order total.
   */
  async ledger(personalityId: string, take = 500, cursor?: string) {
    return this.prisma.person.findMany({
      where: { personalityId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        handle: true,
        displayName: true,
        presentsAs: true,
        nationality: true,
        timesSeen: true,
        createdAt: true,
        assignment: {
          select: {
            state: true,
            handedOutAt: true,
            // What the machine said when it reported back -- "no row read as
            // 'x' in 12 page(s) of the current Quick Add roster" and the like.
            // Written by report() since the beginning and selected by nothing,
            // so the single most diagnostic string in the system could only be
            // read out of psql. A skip with no reason is indistinguishable from
            // a skip whose reason nobody wrote down.
            note: true,
            account: { select: { id: true, label: true } },
          },
        },
      },
    });
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The same instant handedOutToday() bounds on, written so $queryRaw cannot
 * reinterpret it. Binding a JS Date sends timestamptz, which Postgres converts
 * against the session TimeZone before comparing it to a `timestamp` column
 * holding UTC -- silently, and three hours out on this box.
 */
function utcLiteral(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
