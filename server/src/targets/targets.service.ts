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
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { startOfToday, utcLiteral } from '../common/day';
import { effectiveCaps } from '../onboarding/onboarding.service';
import { PrismaService } from '../prisma/prisma.service';

export interface TargetRow {
  handle: string;
  displayName: string;
  nationality: string | null;
  reason: string | null;
}

/** Results an account may report back for a handed-out target. */
export type FollowResult = 'followed' | 'failed' | 'skipped';

/**
 * A claim, and how much of the session budget it left behind.
 *
 * claim() used to return the rows alone, and the caller asked its follow-up
 * questions -- remainingToday, paceSeconds -- afterwards, in their own queries.
 * remainingInWindow cannot be one of those. Between the transaction committing
 * and a second query running, the oldest handout in the window can age out of
 * it, and the answer would come back "there is room" for a batch the session
 * cap had just truncated. That is the exact reading an agent uses to decide the
 * claim ran out of QUEUE rather than out of cap -- and on that reading it runs
 * an irreversible pass that hides people from its Quick Add roster. Being
 * milliseconds wrong there hides somebody the CRM approved and was about to
 * hand out, permanently.
 *
 * So the number leaves the transaction that computed it, alongside the rows.
 */
export interface ClaimResult {
  targets: TargetRow[];
  /**
   * Targets this account may still be handed inside the current rolling
   * window, after this claim. Zero means the window is full: the batch above
   * may be short for that reason and not because the queue ran dry.
   */
  remainingInWindow: number;
  /** How long that window is, so a client can size a wait instead of polling. */
  sessionWindowMinutes: number;
}

/**
 * How long a row may sit `handed_out` with no result before the next claim puts
 * it back in the queue.
 *
 * The agent answers for every row it claims -- worked rows one at a time,
 * unreached rows when the walk ends, leftovers released explicitly on Stop.
 * None of that survives the process being killed, and on 2026-08-19 it was
 * killed sixteen times: a batch of 74 claimed at 13:20 was still being worked at
 * 13:31 and the next line in that log is the agent starting up again at 14:10.
 * The rows it had not reached stayed handed_out for the rest of the day --
 * 78 of them across one personality -- holding cap slots, never re-offered, and
 * sitting on the emulator's roster with an untapped Add button. A dead process
 * cannot report anything, so the server is the only party left to notice.
 *
 * An hour, against a longest-ever observed walk of 1060.8 seconds. Three and a
 * half times the worst case is the margin that keeps this from ever requeueing a
 * row a live machine is still working.
 */
const HANDOUT_TTL_MINUTES = 60;

@Injectable()
export class TargetsService {
  private readonly log = new Logger(TargetsService.name);

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

  /**
   * Follows this account landed today whose cap slot was charged on an EARLIER
   * day -- the batch claimed before midnight and worked after it.
   *
   * Those adds reached Snapchat today and were free of today's budget, because
   * the slot is taken at handout and the follow happens later. On 2026-08-20
   * stephaniecvto made 134 of them against 92 handouts: 43 paid for the day
   * before. `handedOutAt: null` catches the rows left behind by the stale-handout
   * sweep back when it refunded stamps; nothing writes NULL onto a followed row
   * any more.
   */
  async straddledToday(accountId: string): Promise<number> {
    const since = startOfToday();
    return this.prisma.assignment.count({
      where: {
        accountId,
        state: 'followed',
        resultAt: { gte: since },
        OR: [{ handedOutAt: null }, { handedOutAt: { lt: since } }],
      },
    });
  }

  /**
   * The day's budget actually spent: slots charged today, plus follows that
   * landed today on a slot charged before it.
   *
   * One definition, used by remainingToday() here and matched statement for
   * statement inside claim(). They cannot be allowed to drift: an agent told it
   * has budget pays for a capture, a montage and a VISION CALL before the claim
   * gets to disagree with the number that sent it.
   */
  async spentToday(accountId: string): Promise<number> {
    const [handed, straddled] = await Promise.all([
      this.handedOutToday(accountId),
      this.straddledToday(accountId),
    ]);
    return handed + straddled;
  }

  async remainingToday(accountId: string): Promise<number> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        enabled: true,
        onboardedCount: true,
        personality: {
          select: {
            client: {
              select: {
                dailyCapPerAccount: true,
                sessionCapPerAccount: true,
                onboardingDailyCap: true,
                onboardingSessionCap: true,
              },
            },
          },
        },
      },
    });
    if (!account) throw new NotFoundException('account not found');
    if (!account.enabled) return 0;
    // The SAME arithmetic claim() enforces, including which pair of caps applies
    // -- an account told here that it has budget and then handed nothing by the
    // claim has spent a capture, a montage and a vision call learning that.
    const c = account.personality.client;
    const { dailyCap } = effectiveCaps(account.onboardedCount, {
      dailyCap: c.dailyCapPerAccount,
      sessionCap: c.sessionCapPerAccount,
      onboardingDailyCap: c.onboardingDailyCap,
      onboardingSessionCap: c.onboardingSessionCap,
    });
    return Math.max(0, dailyCap - (await this.spentToday(accountId)));
  }

  /**
   * The agent has finished wiping this account. -> the phase it is now in.
   *
   * cleanup -> seeding, once and only once: the timestamp is what makes a
   * repeat visible, and an account already past cleanup is left exactly where it
   * is rather than being sent backwards by a duplicate report from a machine
   * that retried.
   */
  async markCleaned(accountId: string): Promise<string> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { phase: true },
    });
    if (!account) throw new NotFoundException('account not found');
    if (account.phase !== 'cleanup') return account.phase;
    const next = await this.prisma.account.update({
      where: { id: accountId },
      data: { phase: 'seeding', cleanedAt: new Date() },
      select: { phase: true },
    });
    return next.phase;
  }

  /** This account's phase, for the reply the agent acts on. */
  async phaseOf(accountId: string): Promise<string> {
    const a = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { phase: true },
    });
    return a?.phase ?? 'established';
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
   * Claim up to `limit` queued targets, capped by what is left today AND by
   * what is left in this account's rolling session window.
   *
   * Returns fewer rows than asked for -- often zero -- and that is normal, not
   * an error: it means one of the two caps is spent or the queue is empty.
   * Clients should back off rather than retry immediately, and remainingToday
   * and remainingInWindow are what let them tell those three apart. Before the
   * session cap existed a short batch with budget on the clock could only mean
   * an empty queue, and at least one agent in the field reasons that way -- see
   * ClaimResult for what it does with the answer.
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
   * untouched, and both counts still come from handedOutAt rather than from
   * counter columns, so a crashed worker or a rolled-back transaction cannot
   * leak either cap.
   */
  async claim(accountId: string, limit: number): Promise<ClaimResult> {
    const since = utcLiteral(startOfToday());
    return this.prisma.$transaction(async (tx) => {
      // FOR UPDATE OF a, not a bare FOR UPDATE: the caps now come from the
      // client row, and locking that too would serialise the claims of every
      // account the client owns against each other. The lock this needs is on
      // the one account whose budget is about to be counted and spent.
      //
      // The session cap and its window come out of this same statement for that
      // reason: clients is already in the join, so two more columns leave the
      // lock footprint byte-identical, where a second lookup of the client row
      // would not.
      const [row] = await tx.$queryRaw<
        {
          dailyCap: number;
          sessionCap: number;
          onboardingDailyCap: number;
          onboardingSessionCap: number;
          onboardedCount: number;
          phase: string;
          windowMinutes: number;
          enabled: boolean;
        }[]
      >`
        SELECT c."dailyCapPerAccount" AS "dailyCap",
               c."sessionCapPerAccount" AS "sessionCap",
               c."onboardingDailyCap" AS "onboardingDailyCap",
               c."onboardingSessionCap" AS "onboardingSessionCap",
               c."sessionWindowMinutes" AS "windowMinutes",
               a."onboardedCount" AS "onboardedCount",
               a.phase AS "phase",
               a.enabled
        FROM accounts a
        JOIN personalities p ON p.id = a."personalityId"
        JOIN clients c ON c.id = p."clientId"
        WHERE a.id = ${accountId}
        FOR UPDATE OF a
      `;
      if (!row) throw new NotFoundException('account not found');

      // An account still short of ONBOARD_TARGET searched adds is metered by the
      // onboarding pair instead. REPLACING the ordinary caps, not stacking with
      // them: it is doing different work -- typing exact usernames into search on
      // the youngest account on the box -- and the operator sets what that work
      // is worth separately. onboardedCount comes out of the SAME locked row as
      // the caps, so the decision cannot drift from the counting underneath it.
      //
      // The window is shared on purpose. How long a rotation takes is a property
      // of the fleet, not of one account's age, and a second window here would
      // be a second thing to keep in step for no benefit.
      // An account still being wiped is handed NOTHING, and this is the cheapest
      // place to say so -- before a slot is charged, inside the same lock.
      // Seeding an account whose contact sync is still on means Snapchat
      // re-suggesting the very people about to be deleted, and a cap slot spent
      // on a roster that is about to change underneath it.
      if (row.phase === 'cleanup') {
        return { targets: [], remainingInWindow: 0,
                 sessionWindowMinutes: row.windowMinutes };
      }

      const account = {
        enabled: row.enabled,
        windowMinutes: row.windowMinutes,
        ...effectiveCaps(row.onboardedCount, row),
      };
      const windowMinutes = account.windowMinutes;
      if (!account.enabled) {
        // Zero rather than the untouched session budget, to match
        // remainingToday(), which also answers 0 for a disabled account. A
        // client reads the daily number first, so a paused account still
        // presents as "spent" rather than as "this window is full" -- the
        // longer back-off, which is the right one for an account an operator
        // has switched off.
        return { targets: [], remainingInWindow: 0, sessionWindowMinutes: windowMinutes };
      }

      // Before either count, because both of them read handedOutAt and a row
      // nobody ever answered for must not go on spending a slot.
      //
      // RESET, NOT DELETE. The obvious version drops these rows and lets the
      // person come back through the pipeline as if never seen -- and it very
      // nearly works, since filter() is handed every person on a sheet rather
      // than only new ones and allocate() skips exactly those who already have
      // an assignment. What kills it is the gap: for the one cycle between the
      // delete and the next sheet, that person has no assignment, and
      // refusedHandles() is defined as "no assignment, or assigned to another
      // account". The agent would be handed them as refusals and tap the X, and
      // Snapchat never suggests a hidden account again. Resetting in place has
      // no such window -- the row keeps its account, is never a refusal to
      // anybody, and is claimable again immediately below.
      //
      // THE STAMP STAYS. It used to go to NULL, on the reasoning that a handout
      // nobody answered for bought nothing and should not spend a slot -- so the
      // account could reach its cap in follows rather than in handouts. The
      // reasoning has a hole in it: "nobody answered" is not the same as
      // "nothing happened". An agent that taps Add and then dies, is stopped by
      // an operator, or gets wedged behind a modal has made the add on the phone
      // and will never report it. Refunding that slot buys a second real add
      // with the same budget, and the whole point of the cap is the number of
      // adds the PHONE makes.
      //
      // What it cost, measured 2026-08-19 against a 240/day cap: stephaniecvto
      // was charged 363 slots and landed 280 follows, haileodx 289 and 277,
      // haelpjle 262 and 260. Every one of those follows carried a stamp dated
      // that same day, so nothing was orphaned and no reset was pressed -- the
      // budget was simply handed back and spent again, all day.
      //
      // So this now agrees with the `failed` path in report(), which has always
      // requeued while KEEPING the timestamp. The row is still workable, and the
      // person is still reachable; what does not come back is the slot. A day's
      // budget only ever goes down, which is the direction this has to fail in:
      // an interrupted batch loses its remaining slots until midnight, and that
      // is cheaper than a rate limit nobody can see coming.
      //
      // NOW() AT TIME ZONE 'UTC' for the same reason as the window count below:
      // handedOutAt is timestamp WITHOUT time zone holding UTC, and a bare NOW()
      // would be rendered in the session TimeZone.
      const released = await tx.$executeRaw`
        UPDATE assignments
           SET state = 'queued'
         WHERE "accountId" = ${accountId}
           AND state = 'handed_out'
           AND "handedOutAt" < (NOW() AT TIME ZONE 'UTC')
                               - make_interval(mins => ${HANDOUT_TTL_MINUTES}::int)
      `;
      if (released > 0) {
        this.log.warn(
          `claim: requeued ${released} row(s) handed to ${accountId} over ` +
            `${HANDOUT_TTL_MINUTES} minutes ago with no result reported ` +
            `(their cap slots stay spent -- the adds may well have happened)`,
        );
      }

      const [used] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM assignments
        WHERE "accountId" = ${accountId}
          AND "handedOutAt" >= ${since}::timestamp
      `;

      // The slot is charged when a row is HANDED OUT and the follow happens
      // later, so a batch claimed before midnight and worked after it lands on
      // today while its budget was taken from yesterday. Those follows were free,
      // and on 2026-08-20 stephaniecvto made 134 of them against 92 handouts --
      // 43 of them paid for the day before.
      //
      // Counted rather than folded into the query above because the two must not
      // overlap: this asks ONLY for rows whose slot was charged on an earlier day
      // (or refunded before this change stopped that), so adding the two is exact
      // where a max() of the pair would quietly under-count.
      //
      // resultAt, not handedOutAt, because that is when the add reached Snapchat
      // -- which is the only clock a rate limit is keeping.
      const [straddled] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM assignments
        WHERE "accountId" = ${accountId}
          AND state = 'followed'
          AND "resultAt" >= ${since}::timestamp
          AND ("handedOutAt" IS NULL OR "handedOutAt" < ${since}::timestamp)
      `;
      const spentToday = used.n + straddled.n;

      // The same count with a different lower bound, issued inside the same
      // transaction so it sees the same snapshot and is covered by the same
      // held row lock -- no second serialisation point, and no window in which
      // one of the two counts is stale with respect to the other.
      //
      // NOT `NOW() - make_interval(...)`. NOW() is timestamptz and handedOutAt
      // is timestamp WITHOUT time zone holding UTC, so comparing them renders
      // NOW() in the session TimeZone -- Europe/Kiev on this box -- and slides
      // the window three hours. Binding a JS Date computed in the service has
      // the same fault from the other direction, which is what utcLiteral()
      // exists to document. `NOW() AT TIME ZONE 'UTC'` is a bare timestamp
      // holding UTC, the identical expression the UPDATE below writes into the
      // column, and subtracting an interval from it stays a timestamp.
      //
      // make_interval rather than a string-built `n || ' minutes'` interval,
      // because the latter is text arithmetic on a value from the database and
      // buys nothing. The ::int cast is what stops the parameter arriving
      // untyped.
      const [usedInWindow] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM assignments
        WHERE "accountId" = ${accountId}
          AND "handedOutAt" >= (NOW() AT TIME ZONE 'UTC')
                               - make_interval(mins => ${windowMinutes}::int)
      `;

      const roomInWindow = account.sessionCap - usedInWindow.n;
      const take = Math.max(
        0,
        Math.min(limit, account.dailyCap - spentToday, roomInWindow),
      );
      if (take === 0) {
        return {
          targets: [],
          remainingInWindow: Math.max(0, roomInWindow),
          sessionWindowMinutes: windowMinutes,
        };
      }

      // One statement: pick the oldest queued rows for this account, skip any a
      // concurrent poll is already holding, flip them to handed_out, and return
      // them joined to the person. Nothing between the select and the update.
      const rows = await tx.$queryRaw<
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
      ),
      -- Wrapped so the ORDER BY above can survive into the result. RETURNING has
      -- no order in Postgres -- it yields rows in whatever sequence the executor
      -- updated them -- so newest-first was only ever the plan's habit here, and
      -- the plan changes when the statements around it do. Adding one unrelated
      -- count to this transaction was enough to flip the batch into ascending
      -- order, which the suite caught and which nothing downstream would have:
      -- the agent walks its batch against a roster drawn newest-first, so a
      -- reversed batch is not an error anywhere, just a walk that misses more.
      handed AS (
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
                a.reason AS reason,
                a."createdAt" AS "createdAt",
                a.id AS id
      )
      SELECT handle, "displayName", nationality, reason
      FROM handed
      ORDER BY "createdAt" DESC, id DESC
      `;

      // Every row above was just stamped with a handedOutAt inside the window,
      // so it is spent from it. Counted here rather than re-queried because a
      // second count would be answering about a window that has moved on.
      //
      // Exact, not approximate: NOW() inside a transaction is the transaction's
      // start time, so the UPDATE stamped those rows at the same instant the
      // count above bounded on. They cannot land outside the window they were
      // just measured against.
      return {
        targets: rows,
        remainingInWindow: Math.max(0, roomInWindow - rows.length),
        sessionWindowMinutes: windowMinutes,
      };
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
    verified?: boolean,
  ): Promise<void> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { personalityId: true },
    });
    if (!account) throw new NotFoundException('account not found');

    const person = await this.prisma.person.findUnique({
      where: { personalityId_handle: { personalityId: account.personalityId, handle } },
      select: { id: true, source: true },
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

    // A FAILURE THE AGENT SAW GIVES ITS SLOT BACK. ONE IT MERELY COULD NOT READ
    // DOES NOT.
    //
    // The cap is meant to buy a day's ADDS, and a slot spent on an add that
    // provably did not happen buys nothing -- orawvx charged 130 slots for 84
    // follows, and the missing budget was attempts that came back failed.
    // Keeping those charged makes the cap meter attempts, which is not what it
    // is for.
    //
    // But `failed` covers two different events. The pill back grey is evidence
    // the add did not land. A button that could not be read at all is evidence
    // of nothing, and the add may well be on the phone: refunding THAT buys a
    // second real add with one slot, which is how 31bb132 measured
    // stephaniecvto taking 363 slots and landing 280 follows against a cap of
    // 240. So the refund needs the agent to say it watched the thing fail, and
    // silence is read as "unknown" -- the safe half, and what every client that
    // has not been updated already sends.
    const undone = result === 'failed' && verified === true;
    await this.prisma.assignment.update({
      where: { id: assignment.id },
      data: {
        state: result === 'failed' ? 'queued' : result,
        resultAt: new Date(),
        note: note?.slice(0, 500),
        // Clearing it is the refund: handedOutToday counts rows with a
        // handedOutAt in today, and remainingToday is the cap minus that.
        ...(undone ? { handedOutAt: null } : {}),
      },
    });
    if (undone) {
      this.log.log(
        `cap slot returned: ${handle} was watched failing on ${accountId}`,
      );
    }

    // An account is seeded until it has fifty people it found by SEARCHING,
    // which is what a `manual` row is on an account with no roster -- nothing
    // else creates one. Counted on the way in rather than derived on the way
    // out so the number survives the ledger being pruned, and only on a follow
    // that actually landed: a search that found nobody taught Snapchat nothing
    // about this account, which is the whole thing the fifty are for.
    if (result === 'followed' && person.source === 'manual') {
      await this.prisma.account.update({
        where: { id: accountId },
        data: { onboardedCount: { increment: 1 } },
      });
    }
  }

  /**
   * Record that this account swiped a refused person off its own Quick Add.
   *
   * The other half of report(), and the half the server was blind to. An agent
   * is told two things per cycle -- follow these, hide these -- and only the
   * follows came back, so "has that box done its pass" could only be answered by
   * looking at its screen. With twenty boxes that is not an answer.
   *
   * Deliberately NOT routed through report(): these people have no assignment to
   * this account, which is the definition of refused. See the Hide model.
   *
   * Idempotent by (accountId, personId). A roster that re-rolls serves the same
   * face again and hiding it twice is expected, so a repeat moves `at` and bumps
   * `times` rather than erroring or piling up rows -- an agent must never have to
   * remember what it already hid, and a retried POST must be free.
   */
  async hide(accountId: string, handle: string): Promise<void> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { personalityId: true },
    });
    if (!account) throw new NotFoundException('account not found');

    const person = await this.prisma.person.findUnique({
      where: { personalityId_handle: { personalityId: account.personalityId, handle } },
      select: { id: true },
    });
    // A handle nobody has ever read for this personality. The agent hides what
    // the server told it to hide, so this means the two have drifted; it is the
    // server's ledger that is authoritative, and there is nothing to record.
    if (!person) throw new NotFoundException('unknown handle for this personality');

    await this.prisma.hide.upsert({
      where: { accountId_personId: { accountId, personId: person.id } },
      create: { accountId, personId: person.id },
      update: { times: { increment: 1 }, at: new Date() },
    });
  }

  /**
   * Handles this account will never be told to add, newest first.
   *
   * The agent hides these from its emulator's Quick Add roster, which is what
   * makes the next refresh serve new faces instead of the same declined ones.
   * Two populations, and the second is the one that is easy to miss:
   *
   *   no assignment at all      `filter` declined them -- a rule rejected them,
   *                             no rule matched, the country reading was too
   *                             weak, the avatar and the name disagreed, or they
   *                             are a near duplicate. Every drop is silent and
   *                             this is the only place they surface.
   *   assigned to a SIBLING     a person another account of the same personality
   *                             already holds. UNIQUE (personId) means this
   *                             account is never getting them -- that is the
   *                             dedupe the product sells -- so on this roster
   *                             they are permanent clutter. A personality runs
   *                             up to ten accounts, so on the tenth roster this
   *                             is the larger of the two populations.
   *
   * A person assigned to THIS account is excluded whatever their state, and that
   * is the whole safety of it. `queued` is waiting to be handed out, `handed_out`
   * is being followed right now, and `failed` requeues -- hiding any of them
   * would destroy a target this account is about to work. `skipped` is terminal
   * and could safely be hidden, but is left alone: it is usually "no row read as
   * this handle", which is evidence the person was never on the roster to begin
   * with rather than evidence they are cluttering it.
   *
   * Scoped to the personality rather than to the sheets this account uploaded.
   * Narrowing by `firstSeenSheet` would be tighter and is wrong for the case
   * that matters most: when a sibling account saw someone first, the Person row
   * points at the SIBLING's sheet, so exactly the people this account most needs
   * to hide would be the ones filtered out.
   *
   * Sending more handles than are on the roster is therefore expected and
   * harmless. The agent OCRs each row and acts only on an exact match, so a
   * handle that is not on screen is a few bytes and nothing else -- whereas a
   * handle that is missing is a row nobody can ever hide. `take` bounds the
   * reply because the ledger grows without limit and a roster is ~99 people;
   * newest first is what keeps the overlap high, for the same reason the claim
   * hands out newest first.
   */
  async refusedHandles(accountId: string, take = 500): Promise<string[]> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { personalityId: true },
    });
    if (!account) throw new NotFoundException('account not found');

    const people = await this.prisma.person.findMany({
      where: {
        personalityId: account.personalityId,
        OR: [{ assignment: { is: null } }, { assignment: { accountId: { not: accountId } } }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { handle: true },
    });
    return people.map((p) => p.handle);
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

