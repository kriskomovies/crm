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
   * Three queries in total, and it stays three however many personalities
   * exist. The obvious version -- loop the accounts, ask for each account's
   * queued count, followed count and today's handouts -- is three round trips
   * per account: at 100 clients x 10 personalities x 10 accounts that is 30,000,
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
      accounts: p.accounts.map((a) =>
        accountView(a, byAccount.get(a.id) ?? {}, today.get(a.id) ?? 0),
      ),
    }));
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
    await this.assertExists(clientId, personalityId);

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
    if (existing) return { created: false, account: await this.accountWithCounts(existing) };

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

    // dailyCap is left to the column default rather than passed. New accounts
    // hit Snapchat's add-cooldown around 40 a day, so the conservative default
    // is the right starting point and the operator raises it in the CRM.
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
    return { created, account: await this.accountWithCounts(account) };
  }

  /**
   * One account in the shape `list` nests, counters and all.
   *
   * Two queries for one account, where `list` does two for every account a
   * client has. That is the right trade in opposite directions: this runs once
   * per registration, and a registration must answer with live numbers because
   * the agent adopts this object and starts its first cycle from it without a
   * second fetch.
   */
  private async accountWithCounts(a: AccountRow): Promise<AccountView> {
    const [states, handedToday] = await Promise.all([
      this.prisma.assignment.groupBy({
        by: ['state'],
        where: { accountId: a.id },
        _count: { _all: true },
      }),
      this.prisma.assignment.count({
        where: { accountId: a.id, handedOutAt: { gte: startOfToday() } },
      }),
    ]);
    const counts: Record<string, number> = {};
    for (const s of states) counts[s.state] = s._count._all;
    return accountView(a, counts, handedToday);
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

/** The columns every account projection needs. Less than a full Account row. */
type AccountRow = { id: string; label: string; dailyCap: number; enabled: boolean };

export interface AccountView extends AccountRow {
  handedToday: number;
  remainingToday: number;
  queued: number;
  handedOut: number;
  followed: number;
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
  counts: Record<string, number>,
  handedToday: number,
): AccountView {
  return {
    id: a.id,
    label: a.label,
    dailyCap: a.dailyCap,
    enabled: a.enabled,
    handedToday,
    remainingToday: Math.max(0, a.dailyCap - handedToday),
    queued: counts.queued ?? 0,
    handedOut: counts.handed_out ?? 0,
    followed: counts.followed ?? 0,
  };
}

/** Local midnight. Caps reset by the operator's day, not UTC's. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
