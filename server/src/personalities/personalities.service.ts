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
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssignmentState } from '@prisma/client';

import { pageSize, slicePage } from '../common/pagination';
import { isPlausibleHandle, normHandle } from '../extraction/normalize';
import { PipelineService } from '../pipeline/pipeline.service';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class PersonalitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineService,
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
   * Three queries in total, and it stays three however many personalities
   * exist. The obvious version -- loop the accounts, ask for each account's
   * queued count, review count and today's handouts -- is three round trips per
   * account: at 100 clients x 10 personalities x 10 accounts that is 30,000,
   * and the dashboard simply never loads. The counts are fetched as two
   * groupBys and stitched in memory instead.
   */
  async list(clientId: string) {
    const ofClient = { account: { personality: { clientId } } };
    const [rows, states, handedToday] = await Promise.all([
      this.prisma.personality.findMany({
        where: { clientId },
        include: {
          client: { select: { name: true, extractionModel: true } },
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
    ]);

    const byAccount = new Map<string, Record<string, number>>();
    for (const s of states) {
      const bucket = byAccount.get(s.accountId) ?? {};
      bucket[s.state] = s._count._all;
      byAccount.set(s.accountId, bucket);
    }
    const today = new Map(handedToday.map((h) => [h.accountId, h._count._all]));

    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      client: p.client.name,
      model: p.client.extractionModel,
      people: p._count.people,
      accounts: p.accounts.map((a) => {
        const c = byAccount.get(a.id) ?? {};
        const used = today.get(a.id) ?? 0;
        return {
          id: a.id,
          label: a.label,
          dailyCap: a.dailyCap,
          enabled: a.enabled,
          handedToday: used,
          remainingToday: Math.max(0, a.dailyCap - used),
          queued: c.queued ?? 0,
          handedOut: c.handed_out ?? 0,
          followed: c.followed ?? 0,
          review: c.review ?? 0,
        };
      }),
    }));
  }

  /** Adjust an account's cap or pause it without deleting its history. */
  async updateAccount(
    clientId: string,
    accountId: string,
    patch: { dailyCap?: number; enabled?: boolean },
  ) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, personality: { clientId } },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('account not found');
    const updated = await this.prisma.account.update({
      where: { id: accountId },
      data: patch,
    });
    return {
      id: updated.id,
      label: updated.label,
      dailyCap: updated.dailyCap,
      enabled: updated.enabled,
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

  async addAccount(clientId: string, personalityId: string, label: string, dailyCap?: number) {
    await this.assertExists(clientId, personalityId);
    const exists = await this.prisma.account.findUnique({
      where: { personalityId_label: { personalityId, label } },
      select: { id: true },
    });
    if (exists) throw new BadRequestException(`account "${label}" already exists`);

    const account = await this.prisma.account.create({
      data: { personalityId, label, ...(dailyCap === undefined ? {} : { dailyCap }) },
    });
    return {
      id: account.id,
      label: account.label,
      dailyCap: account.dailyCap,
      enabled: account.enabled,
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
  async remove(clientId: string, personalityId: string): Promise<void> {
    await this.assertExists(clientId, personalityId);
    await this.prisma.personality.delete({ where: { id: personalityId } });
  }

  /**
   * Queue newly attached people onto this personality's accounts.
   *
   * Manual adds bypass the client's filter rules deliberately. The filter reads
   * avatar and country, and a typed-in handle has neither -- it would fall
   * through to "confidence below medium" and land in review, so every manual
   * add would need approving twice. Someone naming a handle has already made
   * that decision.
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
    // Bounded before it reaches the database. `contains` becomes a LIKE with
    // the caller's text inlined between two wildcards, and neither the planner
    // nor the pattern matcher enjoys a megabyte of it.
    const needle = q?.trim().slice(0, MAX_SEARCH);
    const people = await this.prisma.person.findMany({
      where: {
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
      },
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
        account: p.assignment?.account.label ?? null,
      })),
      nextCursor,
    };
  }

  /** Everything held back from forwarding, and why. The screen that earns trust. */
  async review(clientId: string, personalityId: string, limit: number, cursor?: string) {
    await this.assertExists(clientId, personalityId);
    const take = pageSize(limit);
    const rows = await this.prisma.assignment.findMany({
      where: { state: 'review', person: { personalityId } },
      include: { person: true, account: { select: { label: true } } },
      // createdAt is not unique; id makes the order total so a cursor page
      // cannot repeat or skip the rows either side of the boundary.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const { items, nextCursor } = slicePage(rows, take);
    return {
      items: items.map((r) => ({
        handle: r.person.handle,
        displayName: r.person.displayName,
        avatarPresentsAs: r.person.avatarPresentsAs,
        namePresentsAs: r.person.namePresentsAs,
        nationality: r.person.nationality,
        reason: r.reason,
        account: r.account.label,
      })),
      nextCursor,
    };
  }

  /** 404 rather than 403 for someone else's personality: the id is the secret. */
  private async assertExists(clientId: string, personalityId: string): Promise<void> {
    const found = await this.prisma.personality.findFirst({
      where: { id: personalityId, clientId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('personality not found');
  }
}

/**
 * `?state=` reaches Prisma as an enum value. Cast unchecked it turned a typo
 * into a 500 from the query engine; the caller gets to know which of the six it
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

/** Local midnight. Caps reset by the operator's day, not UTC's. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
