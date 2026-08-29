/**
 * Personality management, and the manual route into the ledger.
 *
 * Handles reach a personality two ways: a contact-sheet screenshot the pipeline
 * extracts, or someone naming them directly -- an operator in the UI, or the
 * client POSTing a list. This service owns the second path. It writes the same
 * Person rows the pipeline writes, through the same unique constraint, so a
 * manual add and an extracted add dedupe against each other for free.
 *
 * Every method takes the caller's clientId and every query is scoped by it.
 * None of them were, which made a personality id -- a uuid in a URL the
 * operator UI prints -- enough to read, extend or DELETE another tenant's
 * ledger.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AssignmentState, Prisma } from '@prisma/client';

import { startOfToday } from '../common/day';
import { effectiveCaps } from '../onboarding/onboarding.service';
import { pageSize, slicePage } from '../common/pagination';
import { cleanDisplayName, isPlausibleHandle, normHandle } from '../extraction/normalize';
import { PipelineService } from '../pipeline/pipeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { RetentionService } from '../retention/retention.service';

export interface AttachResult {
  added: string[];
  /** Already in THIS personality's ledger. Another personality having them is not a duplicate. */
  duplicate: string[];
  invalid: string[];
  queued: number;
}

/** A handle longer than this is transcription noise, not a truncated handle. */
const MAX_HANDLE_INPUT = 200;

/** Long enough for any real display name; short enough that LIKE stays cheap. */
const MAX_SEARCH = 100;

/** A hostname, not an essay. Context for the operator, never matched on. */
const MAX_MACHINE = 100;

@Injectable()
export class PersonalitiesService {
  private readonly log = new Logger(PersonalitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineService,
    private readonly retention: RetentionService,
  ) {}

  /**
   * Every personality with its accounts and their live counts.
   *
   * DELIBERATELY NOT PAGINATED, and it must stay that way. The result is
   * bounded by how many personalities one client has -- ten, not ten thousand
   * -- and the operator UI needs all of them at once to populate the filter
   * dropdown that the whole stats screen hangs off. Paginating it would make
   * that dropdown lie about what can be filtered on.
   *
   * Five queries in total, and it stays five however many personalities exist.
   * The obvious version -- loop the accounts, ask for each account's queued
   * count, followed count and today's handouts -- is three round trips per
   * account: at 100 clients x 10 personalities x 10 accounts that is 30,000,
   * and the dashboard simply never loads. The counts are fetched as grouped
   * aggregates over the whole client and stitched in memory instead.
   *
   * `rejected` and `alreadyFollowed` added no query at all, and that was the
   * condition of adding them. Both are arithmetic on rows this method already
   * reads -- see personalityTotals.
   *
   * `failedToday` and `followedToday` are the two that could not be had that
   * way, and the rule above is amended rather than quietly broken. The state
   * groupBy carries no date and the handout groupBy carries no state, so "rows in
   * this state that were reported on today" is not a subtraction over either:
   * each is its own grouped query, on the same @@index([accountId, state]) the
   * second one uses, in the same Promise.all. What is still refused is the
   * shape that does not scale --
   * a COUNT per account, which is the pattern PersonalityLedgerController.ledger
   * records as the cost that grows with the ledger. This is polled every five
   * seconds by every open dashboard.
   */
  async list(clientId: string) {
    const ofClient = { account: { personality: { clientId } } };
    const [rows, states, handedToday, failedToday, followedToday, straddledToday] =
      await Promise.all([
      this.prisma.personality.findMany({
        where: { clientId },
        include: {
          client: {
            select: {
              name: true,
              extractionModel: true,
              dailyCapPerAccount: true,
              sessionCapPerAccount: true,
              onboardingDailyCap: true,
              onboardingSessionCap: true,
            },
          },
          accounts: { orderBy: { label: 'asc' } },
          _count: { select: { people: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.assignment.groupBy({
        by: ['accountId', 'state'],
        where: ofClient,
        _count: { _all: true },
      }),
      this.prisma.assignment.groupBy({
        by: ['accountId'],
        where: { ...ofClient, handedOutAt: { gte: startOfToday() } },
        _count: { _all: true },
      }),
      this.prisma.assignment.groupBy({
        by: ['accountId'],
        where: { ...ofClient, ...failedTodayWhere() },
        _count: { _all: true },
      }),
      this.prisma.assignment.groupBy({
        by: ['accountId'],
        where: { ...ofClient, ...followedTodayWhere() },
        _count: { _all: true },
      }),
      this.prisma.assignment.groupBy({
        by: ['accountId'],
        where: { ...ofClient, ...straddledTodayWhere() },
        _count: { _all: true },
      }),
    ]);

    const byAccount = groupCounts(states);
    const today = new Map(handedToday.map((h) => [h.accountId, h._count._all]));
    const missed = new Map(failedToday.map((f) => [f.accountId, f._count._all]));
    const landed = new Map(followedToday.map((f) => [f.accountId, f._count._all]));
    const carried = new Map(straddledToday.map((f) => [f.accountId, f._count._all]));

    return rows.map((p) => {
      // The groupBy above spans the whole client, so the per-personality slice
      // is taken here, off the account list that already came back with the
      // personality. An account with nothing assigned contributes {} and moves
      // no total.
      const counts = p.accounts.map((a) => byAccount.get(a.id) ?? {});
      const totals = personalityTotals(counts);
      return {
        id: p.id,
        name: p.name,
        client: p.client.name,
        model: p.client.extractionModel,
        people: p._count.people,
        // The personality's own number, and it only ever was one. A refusal
        // leaves a Person with no Assignment, so it belongs to no account --
        // accountView still carries it for the registration reply the agent
        // adopts, and printing it in a per-account column made two accounts
        // show the same 236 and read as a bug. Same arithmetic, said once.
        rejected: Math.max(0, p._count.people - totals.assigned),
        accounts: p.accounts.map((a, i) =>
          accountView(
            a,
            // The cap this account is actually metered by, which is not the
            // client's ordinary one while it is still onboarding. The agent
            // reads remainingToday from this row to decide whether to run a
            // cycle at all, so a number from the wrong pair costs it a capture,
            // a montage and a vision call to be handed nothing.
            effectiveCaps(a.onboardedCount, {
              dailyCap: p.client.dailyCapPerAccount,
              sessionCap: p.client.sessionCapPerAccount,
              onboardingDailyCap: p.client.onboardingDailyCap,
              onboardingSessionCap: p.client.onboardingSessionCap,
            }).dailyCap,
            counts[i],
            today.get(a.id) ?? 0,
            missed.get(a.id) ?? 0,
            landed.get(a.id) ?? 0,
            totals,
            p._count.people,
            carried.get(a.id) ?? 0,
          ),
        ),
      };
    });
  }

  /**
   * A machine creating its own account, from the handle it read off its
   * emulator's own profile screen. The operator creates ONLY the personality;
   * nobody types the label in anywhere.
   *
   * This is the /v1 twin of addAccount, and deliberately not the same method.
   * addAccount is the operator's -- it refuses a label that already exists,
   * because an operator typing a name twice has made a mistake. Here a repeat is
   * the NORMAL case: every restart of an already-registered machine takes this
   * path, so an error would mean it could never resolve its account again. The
   * handle on the screen is the identity, and the answer to "register this
   * handle" is the account holding it, whether or not this call created it.
   *
   * The same reasoning is why 409 exists and is narrow: the handle already
   * belonging to ANOTHER of the client's personalities means the operator picked
   * the wrong personality for this emulator, which nothing downstream can
   * detect and no upsert can absorb.
   */
  async registerAccount(
    clientId: string,
    personalityId: string,
    input: { handle: string; displayName?: string; machine?: string },
  ): Promise<{ created: boolean; account: AccountView }> {
    const cap = await this.assertExists(clientId, personalityId);

    const label = normHandle(input.handle);
    if (!isPlausibleHandle(label)) {
      // The rejected value, quoted, and what a handle looks like: this message
      // is read by whoever is stood at the machine, and the usual cause is a
      // misread screen rather than a typo.
      throw new BadRequestException(
        `"${(input.handle ?? '').slice(0, MAX_HANDLE_INPUT)}" is not a Snapchat handle. ` +
          'Expected 3-15 characters starting with a letter, then letters, digits, ' +
          'dot, underscore or hyphen.',
      );
    }

    const existing = await this.prisma.account.findUnique({
      where: { personalityId_label: { personalityId, label } },
    });
    if (existing) {
      return { created: false, account: await this.accountWithCounts(existing, personalityId, cap) };
    }

    // Scoped to this client, and only to its OTHER personalities: the same
    // handle under two clients is two unrelated Snapchat accounts as far as this
    // server can tell, and under THIS personality it was already returned above.
    const elsewhere = await this.prisma.account.findFirst({
      where: { label, personalityId: { not: personalityId }, personality: { clientId } },
      select: { personality: { select: { name: true } } },
    });
    if (elsewhere) {
      throw new ConflictException(
        `"${label}" is already registered under the personality "${elsewhere.personality.name}". ` +
          'Select that personality for this emulator, or check that the right ' +
          'emulator is selected for this one.',
      );
    }

    // No cap is written: a new account is metered by the client's setting from
    // its first cycle, which is the point of that setting being one number.
    const data = {
      personalityId,
      label,
      displayName: cleanDisplayName(input.displayName) || null,
      machine: (input.machine ?? '').trim().slice(0, MAX_MACHINE) || null,
    };

    let account: AccountRow;
    let created = true;
    try {
      account = await this.prisma.account.create({ data });
    } catch (e) {
      // P2002 on (personalityId, label): a concurrent identical registration got
      // there first. Two machines racing must end with ONE account, and the
      // loser is owed the same answer the winner got -- this is the same request
      // twice, not a conflict. Anything else is a real failure and rethrows.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      account = await this.prisma.account.findUniqueOrThrow({
        where: { personalityId_label: { personalityId, label } },
      });
      created = false;
    }
    // Counted after the branches so both answer through one projection: a caller
    // cannot tell whether it won the race from the shape of what it gets back.
    return { created, account: await this.accountWithCounts(account, personalityId, cap) };
  }

  /**
   * One account in the shape `list` nests, counters and all.
   *
   * Five queries for one account, where `list` does five for every account a
   * client has. That is the right trade in opposite directions: this runs once
   * per registration, and a registration must answer with live numbers because
   * the agent adopts this object and starts its first cycle from it without a
   * second fetch.
   *
   * The groupBy is scoped to the PERSONALITY rather than to this account, even
   * though only one account's row is returned. `alreadyFollowed` and `rejected`
   * are both properties of the whole personality -- see personalityTotals -- so
   * counting this account alone would report 0 for both on a machine that is
   * the tenth account of a personality holding thousands of taken handles.
   * One personality runs about ten accounts, so the groupBy is the same size.
   */
  private async accountWithCounts(
    a: AccountRow,
    personalityId: string,
    dailyCap: number,
  ): Promise<AccountView> {
    const [people, states, handedToday, failedToday, followedToday, straddledToday] =
      await Promise.all([
      this.prisma.person.count({ where: { personalityId } }),
      this.prisma.assignment.groupBy({
        by: ['accountId', 'state'],
        where: { account: { personalityId } },
        _count: { _all: true },
      }),
      this.prisma.assignment.count({
        where: { accountId: a.id, handedOutAt: { gte: startOfToday() } },
      }),
      // Per account, unlike the groupBy above: failedToday is this account's own
      // number, where alreadyFollowed and rejected are the personality's. A
      // fourth query here rather than a fourth column on that groupBy, because
      // the groupBy has no date in it and adding one would change what the other
      // two counters mean.
      this.prisma.assignment.count({
        where: { accountId: a.id, ...failedTodayWhere() },
      }),
      this.prisma.assignment.count({
        where: { accountId: a.id, ...followedTodayWhere() },
      }),
      this.prisma.assignment.count({
        where: { accountId: a.id, ...straddledTodayWhere() },
      }),
    ]);
    const byAccount = groupCounts(states);
    const totals = personalityTotals([...byAccount.values()]);
    return accountView(
      a,
      dailyCap,
      byAccount.get(a.id) ?? {},
      handedToday,
      failedToday,
      followedToday,
      totals,
      people,
      straddledToday,
    );
  }

  /**
   * Pause an account, or resume it, without deleting its history.
   *
   * The cap is no longer here: it is Client.dailyCapPerAccount, one setting for
   * the whole client. Pausing stays per-account because "this box is broken" is
   * genuinely about one account, where "how hard do we push" never was.
   */
  async updateAccount(clientId: string, accountId: string, patch: { enabled?: boolean }) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, personality: { clientId } },
      select: { id: true, personality: { select: { client: { select: { dailyCapPerAccount: true } } } } },
    });
    if (!account) throw new NotFoundException('account not found');
    const updated = await this.prisma.account.update({
      where: { id: accountId },
      data: patch,
    });
    return {
      id: updated.id,
      label: updated.label,
      dailyCap: account.personality.client.dailyCapPerAccount,
      enabled: updated.enabled,
      // Carried even though nothing here edits them: the browser patches a row
      // and puts the reply straight back into the list it is rendering, so a
      // field missing from this literal is a column that blanks out the moment
      // an operator presses pause. accountView is not reachable from here --
      // it wants counts this method never fetches -- so these two are copied,
      // and the exact-key test in contract.http.spec.ts is what keeps the copy
      // honest.
      phase: updated.phase,
      onboardedCount: updated.onboardedCount,
    };
  }

  /**
   * Give an account today's cap back, so the same test can be run twice in one
   * day.
   *
   * Both caps are metered by counting handedOutAt rather than by a counter
   * column, so "reset the cap" means exactly "clear today's handedOutAt stamps
   * on this account". That also frees the rolling session window, which counts
   * the same column with a nearer lower bound -- one button, both caps, and
   * worth saying on the button.
   *
   * WHAT IT DOES NOT RESET: anything on the Snapchat side. This is the CRM's
   * bookkeeping. An account that really did 200 adds today and is reset will be
   * handed a fresh dailyCap and will spend it against a cooldown that will not
   * lift, which is the exact spinner the session cap exists to prevent. It is
   * for re-running a test, not for getting more follows out of an account.
   *
   * Two statements, and the split is the whole safety of it:
   *
   *   handed_out rows  go back to `queued` AND lose the stamp. Clearing the
   *                    stamp alone would strand them permanently -- claim()
   *                    only ever picks state='queued', so nothing would hand
   *                    them out again and nothing would count them either.
   *                    They are rows an agent claimed and never reported.
   *   everything else  loses the stamp only. `state` is not in that update's
   *                    `data` at all, which is what makes it structurally
   *                    unable to un-follow anyone or to resurrect a `skipped`
   *                    row -- skips are terminal because re-offering one loops.
   *
   * A followed row losing its stamp cannot be re-handed regardless: claim()
   * filters on state='queued'. The stamp is only its share of today's budget.
   *
   * `resultAt` and `note` are touched by neither, so the failed-today column and
   * the diagnostics an agent wrote survive a reset. A row that failed today
   * still reads as failed today afterwards, which is correct -- the attempt
   * really happened.
   */
  async resetDailyCap(clientId: string, accountId: string) {
    // 404 not 403, scoped through the personality, exactly as updateAccount
    // does: an account id is a uuid the operator UI prints, and the id is the
    // secret.
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, personality: { clientId } },
      select: {
        id: true,
        label: true,
        personality: { select: { client: { select: { dailyCapPerAccount: true } } } },
      },
    });
    if (!account) throw new NotFoundException('account not found');

    const since = startOfToday();
    // Read before the transaction clears the stamps, because clearing them is
    // what turns these rows into "straddled" ones -- counting after would be
    // counting the same fact through a column this is about to rewrite.
    const followedToday = await this.prisma.assignment.count({
      where: { accountId, ...followedTodayWhere() },
    });
    const freed = await this.prisma.$transaction(async (tx) => {
      // The same row lock claim() takes, on the same account row. claim()
      // serialises on FOR UPDATE OF a and counts handedOutAt underneath it; a
      // reset that skips the lock can interleave with a poll already in flight,
      // so rows get stamped after being cleared -- the freed budget spent again
      // before the operator has read the number -- or cleared after being
      // stamped, and the remainingInWindow the agent was just handed is wrong.
      // Same lock, same footprint: this account only, no sibling touched.
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE`;

      const requeued = await tx.assignment.updateMany({
        where: { accountId, state: 'handed_out', handedOutAt: { gte: since } },
        data: { state: 'queued', handedOutAt: null },
      });
      const rest = await tx.assignment.updateMany({
        // The rows above are already excluded twice over -- their stamp is now
        // NULL, which fails the `gte`, and their state is no longer handed_out
        // -- so the two counts cannot overlap.
        where: { accountId, state: { not: 'handed_out' }, handedOutAt: { gte: since } },
        data: { handedOutAt: null },
      });
      return { requeued: requeued.count, cleared: requeued.count + rest.count };
    });

    return {
      id: account.id,
      label: account.label,
      // Two numbers because they answer two questions: `cleared` is how many of
      // today's cap slots came back, `requeued` is how many rows were stuck
      // mid-flight and are workable again.
      ...freed,
      // Exact rather than re-counted: nothing on this account is left holding a
      // stamp inside today, and the lock was held while that became true.
      handedToday: 0,
      // NOT the full cap any more, and that is what makes this button safe to
      // press. Clearing the stamps frees the SLOTS; it cannot unmake the adds
      // Snapchat has already seen, and this method's own warning above says so --
      // "an account that really did 200 adds today and is reset will be handed a
      // fresh dailyCap and will spend it against a cooldown that will not lift".
      // It was handed one because this number was a literal.
      //
      // A followed row whose stamp this just cleared is exactly the shape
      // straddledTodayWhere() matches, so those adds go on counting while the
      // slots they no longer hold come back. Re-running a test still resets
      // cleanly, because a test has not followed anybody; an account that spent
      // its day does not get a second one.
      remainingToday: Math.max(0, account.personality.client.dailyCapPerAccount - followedToday),
    };
  }

  /**
   * The owning client comes from the API key, never from the body. It used to
   * be an optional body field that fell back to "the only client, if there is
   * exactly one" -- which was fine while the route was unauthenticated and
   * single-tenant, and became a way to plant a personality inside another
   * tenant the moment it was not.
   */
  async create(clientId: string, name: string) {
    const exists = await this.prisma.personality.findUnique({
      where: { clientId_name: { clientId, name } },
      select: { id: true },
    });
    if (exists) throw new BadRequestException(`personality "${name}" already exists`);

    const created = await this.prisma.personality.create({
      data: { clientId, name },
    });
    return { id: created.id, name: created.name, clientId: created.clientId, accounts: [] };
  }

  async addAccount(clientId: string, personalityId: string, label: string) {
    const cap = await this.assertExists(clientId, personalityId);
    const exists = await this.prisma.account.findUnique({
      where: { personalityId_label: { personalityId, label } },
      select: { id: true },
    });
    if (exists) throw new BadRequestException(`account "${label}" already exists`);

    const account = await this.prisma.account.create({ data: { personalityId, label } });
    return {
      id: account.id,
      label: account.label,
      // Echoed so a caller learns what this account will actually be metered
      // at, even though it is the client's setting and not this row's.
      dailyCap: cap,
      enabled: account.enabled,
      // A brand-new account is on the first rung of the ladder, and the row the
      // browser draws from this reply has to say so -- otherwise the operator
      // adds an account and sees a blank where its onboarding status belongs
      // until the next poll fills it in.
      phase: account.phase,
      onboardedCount: account.onboardedCount,
    };
  }

  /**
   * Attach handles to a personality.
   *
   * A handle already held by a DIFFERENT personality is not a duplicate and is
   * not rejected: the constraint is `UNIQUE (personalityId, handle)`, so kris
   * and mia may both follow the same person. Only a repeat within this same
   * personality is refused.
   *
   * Unparseable handles are returned rather than dropped. Silently discarding
   * them would let a client believe a list of 500 was accepted when half of it
   * was transcription noise.
   */
  async attach(
    clientId: string,
    personalityId: string,
    handles: string[],
    source: 'manual' | 'extraction',
  ): Promise<AttachResult> {
    await this.assertExists(clientId, personalityId);

    const invalid: string[] = [];
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const raw of handles) {
      const handle = normHandle(raw);
      if (!isPlausibleHandle(handle)) {
        // Echoed back so the caller can see what was rejected, and truncated so
        // a megabyte of pasted noise cannot be reflected a thousand times over.
        invalid.push(raw.slice(0, MAX_HANDLE_INPUT));
        continue;
      }
      // The same handle twice in one request is not an error, just redundant.
      if (seen.has(handle)) continue;
      seen.add(handle);
      valid.push(handle);
    }

    // Three statements for the whole batch instead of an INSERT per handle: a
    // thousand-handle POST was a thousand sequential round trips.
    const before = await this.prisma.person.findMany({
      where: { personalityId, handle: { in: valid } },
      select: { handle: true },
    });
    const duplicate = before.map((p) => p.handle);
    const dupes = new Set(duplicate);
    const added = valid.filter((h) => !dupes.has(h));

    let newPersonIds: string[] = [];
    if (added.length) {
      // skipDuplicates is ON CONFLICT DO NOTHING on (personalityId, handle),
      // the same constraint the per-row version caught P2002 from. A handle a
      // concurrent request created in the gap is reported as added rather than
      // duplicate; it is still exactly one row, and queueing it is a no-op.
      await this.prisma.person.createMany({
        data: added.map((handle) => ({ personalityId, handle, displayName: '', source })),
        skipDuplicates: true,
      });
      const created = await this.prisma.person.findMany({
        where: { personalityId, handle: { in: added } },
        select: { id: true },
      });
      newPersonIds = created.map((p) => p.id);
    }

    return { added, duplicate, invalid, queued: await this.queueAll(personalityId, newPersonIds) };
  }

  /** Delete a personality and everything hanging off it. */
  /**
   * Delete one account, and everything the database hangs off it.
   *
   * Account -> Assignment, Hide and Sheet are all ON DELETE CASCADE, so this is
   * not a tidy-up: it destroys that account's follow history, every row it was
   * ever handed, and every sheet it uploaded. The people themselves survive --
   * they belong to the PERSONALITY -- and their assignments going away is what
   * frees them to be handed to a sibling, which is usually the reason an
   * operator is deleting the account in the first place.
   *
   * Storage keys are collected and purged BEFORE the cascade, for the reason
   * remove() gives above: the rows holding those keys are about to vanish, and
   * an object with nothing left in the database that knows its name is not
   * merely wasted space, it is unfindable waste.
   *
   * onboarding_handles survives on purpose. Its usedByAccountId is ON DELETE SET
   * NULL rather than CASCADE, so deleting the account keeps the record that a
   * handle was already spent -- otherwise the next account would be handed
   * somebody this client has already added.
   *
   * -> what was destroyed, because a caller that has just done this irreversibly
   * should be told what it cost rather than a bare 204.
   */
  async removeAccount(clientId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, personality: { clientId } },
      select: { id: true, label: true },
    });
    if (!account) throw new NotFoundException('account not found');

    const [states, sheets] = await Promise.all([
      this.prisma.assignment.groupBy({
        by: ['state'],
        where: { accountId },
        _count: { _all: true },
      }),
      this.prisma.sheet.findMany({
        where: { accountId, storageKey: { not: null } },
        select: { storageKey: true },
      }),
    ]);
    const counts = Object.fromEntries(states.map((s) => [s.state, s._count._all]));

    const purged = await this.retention.purgeKeys(sheets.map((s) => s.storageKey));
    await this.prisma.account.delete({ where: { id: accountId } });

    this.log.log(
      `deleted account ${account.label}: ${sheets.length} sheets ` +
        `(${purged} objects purged), assignments ${JSON.stringify(counts)}`,
    );
    return {
      id: account.id,
      label: account.label,
      followed: counts.followed ?? 0,
      queued: counts.queued ?? 0,
      sheets: sheets.length,
      purged,
    };
  }

  async remove(clientId: string, personalityId: string): Promise<void> {
    await this.assertExists(clientId, personalityId);

    // Collect the storage keys BEFORE the cascade, and delete the objects
    // first. Personality -> Account -> Sheet is ON DELETE CASCADE, so the rows
    // holding every storageKey are about to vanish; anything not removed now
    // stays on disk forever with nothing left in the database that knows its
    // name. Orphans are not merely wasted space, they are unfindable waste.
    const sheets = await this.prisma.sheet.findMany({
      where: { account: { personalityId }, storageKey: { not: null } },
      select: { storageKey: true },
    });
    const purged = await this.retention.purgeKeys(sheets.map((s) => s.storageKey));

    await this.prisma.personality.delete({ where: { id: personalityId } });

    if (sheets.length) {
      this.log.log(
        `personality ${personalityId} deleted: purged ${purged}/${sheets.length} sheet image(s)`,
      );
    }
  }

  /**
   * Queue newly attached people onto this personality's accounts.
   *
   * Manual adds bypass the client's filter rules deliberately. The filter reads
   * avatar and country, and a typed-in handle has neither -- it would fall
   * through to "confidence below medium" and be dropped, so every manual add
   * would silently go nowhere. Someone naming a handle has already made the
   * decision the filter exists to make.
   *
   * Spread across accounts by current queue depth rather than piling onto the
   * first one, because a single account can only ever hand out its dailyCap.
   */
  private async queueAll(personalityId: string, personIds: string[]): Promise<number> {
    if (personIds.length === 0) return 0;
    const accounts = await this.prisma.account.findMany({
      where: { personalityId, enabled: true },
      select: { id: true },
      orderBy: { label: 'asc' },
    });
    // No enabled account yet: the people stay in the ledger unassigned and are
    // picked up once one is added, rather than being lost.
    if (accounts.length === 0) return 0;

    // One groupBy rather than a count per account: a personality runs about ten
    // accounts, and this path runs on every manual attach.
    const depth = await this.prisma.assignment.groupBy({
      by: ['accountId'],
      where: { accountId: { in: accounts.map((a) => a.id) }, state: 'queued' },
      _count: { _all: true },
    });
    const load = new Map<string, number>(accounts.map((a) => [a.id, 0]));
    for (const d of depth) load.set(d.accountId, d._count._all);

    // Balance in memory, then write once per account. Allocating person by
    // person made a 1000-handle attach 1000 inserts; there are about ten
    // accounts, so this is ten.
    const batches = new Map<string, { personId: string; action: 'forward'; reason: string }[]>();
    for (const personId of personIds) {
      let pick = accounts[0].id;
      for (const a of accounts) {
        if (load.get(a.id)! < load.get(pick)!) pick = a.id;
      }
      load.set(pick, load.get(pick)! + 1);
      const batch = batches.get(pick) ?? [];
      batch.push({ personId, action: 'forward', reason: 'added manually' });
      batches.set(pick, batch);
    }

    let queued = 0;
    for (const [accountId, decisions] of batches) {
      queued += await this.pipeline.allocate(accountId, decisions);
    }
    return queued;
  }

  /**
   * The handles one personality holds, and which account has each.
   *
   * Cursor-paginated on id, not offset. A personality that has been running for
   * a month holds tens of thousands of rows, and OFFSET makes the database walk
   * and discard every row before the page -- page 200 costs 200 times page 1.
   * The cursor makes every page cost the same.
   */
  async targets(
    clientId: string,
    personalityId: string,
    limit: number,
    q?: string,
    state?: string,
    cursor?: string,
  ) {
    await this.assertExists(clientId, personalityId);
    const take = pageSize(limit);
    const people = await this.prisma.person.findMany({
      where: ledgerWhere(personalityId, q, state),
      orderBy: { id: 'asc' },
      // Fetch one extra to learn whether another page exists without a second
      // count query over the whole table.
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { assignment: { include: { account: { select: { label: true } } } } },
    });

    const { items, nextCursor } = slicePage(people, take);
    return {
      items: items.map((p) => ({
        handle: p.handle,
        displayName: p.displayName,
        source: p.source,
        presentsAs: p.presentsAs,
        avatarPresentsAs: p.avatarPresentsAs,
        namePresentsAs: p.namePresentsAs,
        nationality: p.nationality,
        nationalityConf: p.nationalityConf,
        timesSeen: p.timesSeen,
        state: p.assignment?.state ?? null,
        reason: p.assignment?.reason ?? null,
        // Why the machine ended it that way. `reason` says why we FORWARDED
        // them; this says what happened when someone tried. Two different
        // questions, and only the first was answerable from the UI.
        note: p.assignment?.note ?? null,
        account: p.assignment?.account.label ?? null,
        handedOutAt: p.assignment?.handedOutAt ?? null,
        followedAt: followedAt(p.assignment),
      })),
      nextCursor,
    };
  }

  /**
   * The same rows `targets` pages, as one stream, for the CSV export.
   *
   * Two things are deliberate here and both are about size. The rows arrive a
   * batch at a time through the same keyset cursor the page uses, so the server
   * holds one batch however large the ledger is -- a personality running for a
   * month is tens of thousands of people, and `findMany` with no take is the
   * version of this that falls over on the operator it was built for. And the
   * export exists at all on the server rather than in the browser because the
   * client version is 100 sequential requests at the 500-row API ceiling, held
   * in memory twice, where a page that fails at request 73 produces a CSV that
   * is silently short and looks complete.
   *
   * EXPORT_BATCH is not pageSize(): 500 is the ceiling on what an API caller may
   * ask for in one response, which has nothing to do with how many rows this
   * walks internally per round trip.
   *
   * Ordered [createdAt desc, id desc] rather than `targets`' id asc. It is the
   * order TargetsService.ledger already walks, it puts the newest handles at the
   * top of the file where the operator wants them, and it is served by the
   * existing people(personalityId, createdAt) index -- where id asc has no index
   * to walk and makes the database sort the personality per batch.
   *
   * Validation and the ownership check run BEFORE the generator, not inside it:
   * a 404 or a 400 raised after the first byte is written cannot be turned back
   * into a status code, and the operator would download a truncated file instead
   * of seeing an error.
   */
  async exportTargets(
    clientId: string,
    personalityId: string,
    q?: string,
    state?: string,
    conf?: string,
  ): Promise<{ name: string; rows: AsyncGenerator<ExportRow[]> }> {
    // Not assertExists: this needs the personality's NAME for the filename, and
    // the per-account cap that one returns means nothing to an export. Same
    // scoping, same 404-rather-than-403 -- the id is the secret.
    const personality = await this.prisma.personality.findFirst({
      where: { id: personalityId, clientId },
      select: { name: true },
    });
    if (!personality) throw new NotFoundException('personality not found');

    const where = ledgerWhere(personalityId, q, state, conf);
    return { name: personality.name, rows: this.exportPages(where) };
  }

  private async *exportPages(where: Prisma.PersonWhereInput): AsyncGenerator<ExportRow[]> {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.person.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: EXPORT_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          handle: true,
          displayName: true,
          nationality: true,
          source: true,
          assignment: {
            select: {
              state: true,
              handedOutAt: true,
              resultAt: true,
              account: { select: { label: true } },
            },
          },
        },
      });
      if (rows.length === 0) return;
      yield rows.map((p) => ({
        handle: p.handle,
        displayName: p.displayName,
        nationality: p.nationality,
        source: p.source,
        state: p.assignment?.state ?? null,
        account: p.assignment?.account.label ?? null,
        handedOutAt: p.assignment?.handedOutAt ?? null,
        followedAt: followedAt(p.assignment),
      }));
      // A short batch is the last one. Terminating on the row count rather than
      // on a COUNT of the whole personality is the same reason slicePage reads
      // one row past a page: the count is the query that gets slower as the
      // ledger grows.
      if (rows.length < EXPORT_BATCH) return;
      cursor = rows[rows.length - 1].id;
    }
  }

  /**
   * 404 rather than 403 for someone else's personality: the id is the secret.
   *
   * Returns the owning client's per-account cap, because every caller that
   * needs to prove the personality exists is also about to describe one of its
   * accounts, and the cap is one join away on a row already being read.
   */
  private async assertExists(clientId: string, personalityId: string): Promise<number> {
    const found = await this.prisma.personality.findFirst({
      where: { id: personalityId, clientId },
      select: { client: { select: { dailyCapPerAccount: true } } },
    });
    if (!found) throw new NotFoundException('personality not found');
    return found.client.dailyCapPerAccount;
  }
}

/**
 * `?state=` reaches Prisma as an enum value. Cast unchecked it turned a typo
 * into a 500 from the query engine; the caller gets to know which of the five it
 * should have sent.
 */
function assignmentState(raw: string): AssignmentState {
  const state = Object.values(AssignmentState).find((s) => s === raw);
  if (!state) {
    throw new BadRequestException(
      `unknown state "${raw}"; expected one of ${Object.values(AssignmentState).join(', ')}`,
    );
  }
  return state;
}

/**
 * The where-clause `targets` pages and `exportTargets` streams.
 *
 * One function because the export must show exactly the rows the screen showed
 * -- an export that quietly searched or filtered differently from the list
 * above it is a file the operator has no way to notice is wrong.
 */
/**
 * Which confidences an operator may ask for, and what an unrecognised one means.
 *
 * The extractor writes `high`, `medium`, `low` or nothing at all -- nothing when
 * the model gave no confidence for the nationality it read. That fourth case is
 * NOT low: it is unknown, and lumping it in with low would quietly export people
 * nobody has an opinion about as people we have a poor opinion of.
 */
const CONFIDENCES = ['high', 'medium', 'low'] as const;

function confidenceFilter(conf?: string): Prisma.PersonWhereInput {
  const wanted = (conf ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => (CONFIDENCES as readonly string[]).includes(c));
  if (wanted.length === 0 || wanted.length === CONFIDENCES.length) return {};
  return { nationalityConf: { in: wanted } };
}

function ledgerWhere(
  personalityId: string,
  q?: string,
  state?: string,
  conf?: string,
): Prisma.PersonWhereInput {
  // Bounded before it reaches the database. `contains` becomes a LIKE with the
  // caller's text inlined between two wildcards, and neither the planner nor
  // the pattern matcher enjoys a megabyte of it.
  const needle = q?.trim().slice(0, MAX_SEARCH);
  return {
    personalityId,
    ...(needle
      ? {
          OR: [
            { handle: { contains: needle.toLowerCase() } },
            { displayName: { contains: needle, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(state ? { assignment: { state: assignmentState(state) } } : {}),
    ...confidenceFilter(conf),
  };
}

/**
 * When the follow actually happened, and null when it did not happen.
 *
 * `resultAt` is stamped by report() for followed, skipped AND failed, so
 * serving it under the name "followed at" would date a refusal as an
 * acquisition -- on the one screen whose entire purpose is the people that were
 * acquired.
 */
function followedAt(assignment: { state: AssignmentState; resultAt: Date | null } | null): Date | null {
  return assignment?.state === 'followed' ? assignment.resultAt : null;
}

/** One row of the CSV, and of the followed list the CSV is an export of. */
export interface ExportRow {
  handle: string;
  displayName: string;
  nationality: string | null;
  source: string;
  state: AssignmentState | null;
  account: string | null;
  handedOutAt: Date | null;
  followedAt: Date | null;
}

/**
 * Rows per round trip while streaming the export.
 *
 * Deliberately not pageSize(). MAX_LIMIT is the ceiling on what one API
 * response may carry, which says nothing about how many rows this walks
 * internally between writes to a socket.
 */
const EXPORT_BATCH = 1000;

/** The columns every account projection needs. Less than a full Account row. */
type AccountRow = {
  id: string;
  label: string;
  enabled: boolean;
  phase: string;
  onboardedCount: number;
};

export interface AccountView extends AccountRow {
  /**
   * Where this account is on the ladder: three cleanup rungs, then seeding,
   * then established. Served because the console is the only place an operator
   * can watch a wipe happen -- it takes twenty minutes across three steps on a
   * device they are not looking at, and an account handing out nothing looks
   * exactly like one with a spent cap until this says which it is.
   */
  phase: string;
  /**
   * Searched adds landed so far, out of ONBOARD_TARGET. The denominator is not
   * sent: it is a constant, and a number the server can change under a browser
   * holding a stale copy is worse than one the browser states itself.
   */
  onboardedCount: number;
  /** The client's setting, echoed per account because that is what meters it. */
  dailyCap: number;
  handedToday: number;
  remainingToday: number;
  queued: number;
  followed: number;
  /**
   * People this personality holds that no account was given -- the filter
   * declined them, and a drop is a bare `continue` in PipelineService.filter, so
   * "no assignment row" IS refused. A property of the PERSONALITY, so it reads
   * the same on every account row of one card; that repetition is correct and
   * is the first time the silent-drop count appears anywhere in the UI.
   */
  rejected: number;
  /**
   * People a SIBLING account of this personality already followed. UNIQUE
   * (personId) means this account can never be handed them -- that is the
   * dedupe the product sells -- so this is the honest answer to "why is this
   * account getting so few people". On the tenth account of a personality it is
   * most of the ledger.
   */
  alreadyFollowed: number;
  /**
   * Attempts this account made TODAY that missed, and are queued to be tried
   * again. Not a count of `state = 'failed'` -- see failedTodayWhere for why
   * that column would read 0 forever on a live deployment.
   *
   * The name carries "today" and has to. Every other counter on this row is
   * all-time, so a today-scoped one sitting among them unmarked would be a lie
   * by adjacency; `handedToday` set that precedent. Today is also the scope the
   * number is useful at, because the question it answers is "how much of this
   * run missed", asked by the same operator who is about to press reset.
   */
  failedToday: number;
  /**
   * Follows this account landed TODAY -- see followedTodayWhere. Today-scoped and
   * named for it, like handedToday and failedToday.
   *
   * This is the counter to watch while a run is in progress: it is the only one
   * on the row that a single follow moves, so a dashboard polling every five
   * seconds shows the run advancing through it and through nothing else.
   */
  followedToday: number;
}

/**
 * The two numbers an account's new columns are arithmetic on, tallied once per
 * personality from state counts that were already fetched.
 */
interface PersonalityTotals {
  /** Followed under every account of this personality, this one included. */
  followed: number;
  /** Assignment rows under every account of it, whatever state they are in. */
  assigned: number;
}

/** groupBy(accountId, state) rows folded into one state->count record per account. */
function groupCounts(
  rows: { accountId: string; state: AssignmentState; _count: { _all: number } }[],
): Map<string, Record<string, number>> {
  const byAccount = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const bucket = byAccount.get(r.accountId) ?? {};
    bucket[r.state] = r._count._all;
    byAccount.set(r.accountId, bucket);
  }
  return byAccount;
}

function personalityTotals(counts: Record<string, number>[]): PersonalityTotals {
  let followed = 0;
  let assigned = 0;
  for (const c of counts) {
    followed += c.followed ?? 0;
    for (const n of Object.values(c)) assigned += n;
  }
  return { followed, assigned };
}

/**
 * The one account shape the API hands out, in `GET /api/personalities` and in
 * the reply to a machine registering itself.
 *
 * One function rather than two literals because the agent adopts the
 * registration reply directly and starts its first cycle from it -- it is the
 * same object it would otherwise have read from the list, so the two drifting
 * apart would be a field the agent silently stops finding.
 */
function accountView(
  a: AccountRow,
  dailyCap: number,
  counts: Record<string, number>,
  handedToday: number,
  failedToday: number,
  followedToday: number,
  totals: PersonalityTotals,
  people: number,
  straddledToday = 0,
): AccountView {
  const followed = counts.followed ?? 0;
  return {
    id: a.id,
    label: a.label,
    dailyCap,
    enabled: a.enabled,
    phase: a.phase,
    onboardedCount: a.onboardedCount,
    // Still here, and load-bearing twice over: remainingToday below is computed
    // from it, and it is what the daily-cap bar draws -- the safety feature, and
    // a different column from the `handed out` state count that this change
    // removed. Only the state count went.
    handedToday,
    // The SAME arithmetic TargetsService.claim enforces -- used + straddled --
    // because an account told it has budget spends a capture, a montage and a
    // vision call before the claim gets to disagree. `handedToday` alone is what
    // it used to be, and it read high by exactly the follows whose slot was
    // charged yesterday. Defaulted to 0 so a caller that has not counted them
    // (resetDailyCap, which has just cleared today outright) still reads
    // correctly rather than being forced to pass a zero it does not mean.
    remainingToday: Math.max(0, dailyCap - handedToday - straddledToday),
    queued: counts.queued ?? 0,
    followed,
    // Every Person either has exactly one Assignment (UNIQUE personId) or none,
    // so the people with none are the difference. Math.max guards one invariant
    // the database does not enforce: an Assignment's account always belongs to
    // its Person's personality, which holds by construction -- allocate() writes
    // to the sheet's own account and queueAll() only picks accounts
    // `where: { personalityId }` -- and would make this subtraction negative if
    // it ever broke. Known residual: deleting an Account cascades its
    // assignments away, and those people then read as rejected.
    rejected: Math.max(0, people - totals.assigned),
    // Followed by any account of this personality, minus the ones this account
    // followed itself. No query of its own: the state counts of every sibling
    // were already fetched to fill in `queued` and `followed`.
    alreadyFollowed: totals.followed - followed,
    failedToday,
    followedToday,
  };
}

/**
 * Rows this account attempted today and missed.
 *
 * NOT `state: 'failed'`. AssignmentState has that value and nothing in the
 * server ever writes it: TargetsService.report is the only writer of a result,
 * and it stores a failure as `state: 'queued'` so the row is retried rather than
 * lost. A column counting `failed` would read 0 on every real deployment
 * forever, and be non-zero only against seeded data -- which is worse than not
 * shipping the column, because 0 looks like good news.
 *
 * What a failure actually leaves is this pair, and the pair is exclusive to it:
 * allocate() creates rows queued with no resultAt, claim() moves queued to
 * handed_out and never writes resultAt, and report() is the only writer of
 * resultAt and the only path back to queued. So `queued AND resultAt set` means
 * "reported failed", and nothing else produces it.
 *
 * `note` is deliberately not part of the test even though report() writes it on
 * the same statement: ReportDto.note is @IsOptional(), so an agent that reports
 * a failure with no text would be dropped from the count and the number would
 * silently undershoot. resultAt is unconditional.
 */
function failedTodayWhere() {
  return { state: AssignmentState.queued, resultAt: { gte: startOfToday() } };
}

/**
 * Rows this account actually followed today.
 *
 * The one number on the row that moves on every single follow, and the reason it
 * exists. `handedToday` is what the cap bar draws, and it is a count of SLOTS
 * TAKEN: it jumps by a whole batch the moment an agent claims, then sits still
 * for the twenty minutes the agent spends working through that batch. Watching
 * it during a run and concluding nothing is happening is the correct reading of
 * the wrong number. `followed` next to it is all-time, so on an account with a
 * long history it moves by one in a four-digit figure and reads as frozen too.
 *
 * Safe as `state = 'followed'` where failedToday could not be, because followed
 * is terminal -- report() is the only writer and it never moves a row out of it,
 * so the state and the timestamp cannot disagree later.
 */
function followedTodayWhere() {
  return { state: AssignmentState.followed, resultAt: { gte: startOfToday() } };
}

/**
 * Follows this account landed today whose cap slot was charged on an EARLIER day.
 *
 * The slot is taken when a row is handed out and the add happens later, so a
 * batch claimed before midnight and worked after it lands on today having spent
 * yesterday's budget. Those follows are free unless somebody counts them, and on
 * 2026-08-20 stephaniecvto made 134 of them against 92 handouts -- 43 paid for
 * the day before.
 *
 * It exists so `remainingToday` can be the SAME arithmetic the claim enforces
 * (TargetsService.claim: used + straddled). When these two disagree the agent
 * reads budget it will not be given, and pays for a capture, a montage and a
 * vision call to find that out -- which is the one thing has_budget_today() was
 * written to avoid.
 *
 * `handedOutAt: null` is in the OR for the rows that predate the claim fix that
 * stopped the stale-handout sweep refunding stamps. Nothing writes NULL onto a
 * followed row any more; these are the ones already in the table.
 */
function straddledTodayWhere() {
  const since = startOfToday();
  return {
    state: AssignmentState.followed,
    resultAt: { gte: since },
    OR: [{ handedOutAt: null }, { handedOutAt: { lt: since } }],
  };
}

