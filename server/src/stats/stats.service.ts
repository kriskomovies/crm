/**
 * Dashboard aggregates for one client's book of work.
 *
 * Every number here is counted by Postgres. The obvious implementation --
 * findMany the range and reduce in JavaScript -- is indistinguishable from this
 * one against the hundred rows in dev and is an out-of-memory crash against a
 * personality holding a million people. So the rule is absolute: nothing whose
 * size grows with data volume is allowed to cross into Node.
 *
 * What IS stitched together in memory is only ever pre-aggregated buckets keyed
 * by account, personality or country. Those are bounded by how much the
 * business has sold, not by how much work it has done, and the same trade is
 * already made in PersonalitiesService.list().
 *
 * The whole response is nine queries and stays nine queries at any data size.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { startOfToday, utcLiteral } from '../common/day';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Widest window we will scan. Without a ceiling a bookmarked
 * `?from=2000-01-01` quietly turns the dashboard into a decade-long table scan
 * that nobody asked for and nobody is watching.
 */
const MAX_RANGE_DAYS = 400;
const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 86_400_000;

export interface StatsQuery {
  personalityId?: string;
  from?: string;
  to?: string;
}

/** Shapes returned by the three raw queries. Exported because they surface in
 *  the controller's inferred return type, and so in the generated OpenAPI. */
export interface DayRow {
  date: string;
  sheets: number;
  targets: number;
  followed: number;
  usd: number;
}

interface AccountCostRow {
  accountId: string;
  sheets: number;
  usd: number;
  profilesRead: number;
  promptTokens: number;
  completionTokens: number;
}

export interface CountryRow {
  nationality: string | null;
  count: number;
  forwarded: number;
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(clientId: string, query: StatsQuery) {
    // The documented URL shape is `?personalityId=&from=&to=`, so an empty
    // value means "unset". Taken literally it would instead mean "the
    // personality whose id is the empty string" and every unfiltered load
    // would 404.
    const personalityId = query.personalityId?.trim() || undefined;
    const { from, toExclusive, firstDay, lastDay } = resolveRange(
      query.from?.trim() || undefined,
      query.to?.trim() || undefined,
    );

    // Doubles as the existence check and as the account roster byAccount needs,
    // so a filtered request does not pay for a second lookup.
    //
    // clientId is in the predicate, not checked afterwards: another client's
    // personality has to come back as "no rows" so it 404s below. The id is the
    // secret, so a 403 here would confirm that the id exists.
    const personalities = await this.prisma.personality.findMany({
      where: { clientId, ...(personalityId ? { id: personalityId } : {}) },
      select: {
        id: true,
        name: true,
        accounts: { select: { id: true, label: true }, orderBy: { label: 'asc' } },
        // One number for every account this client runs -- see
        // Client.dailyCapPerAccount. Read here so byAccount can still report
        // what each account is metered at without a second query.
        client: { select: { dailyCapPerAccount: true } },
      },
      orderBy: { name: 'asc' },
    });
    if (personalityId && personalities.length === 0) {
      throw new NotFoundException('personality not found');
    }

    const accountIds = personalities.flatMap((p) => p.accounts.map((a) => a.id));
    const personalityIds = personalities.map((p) => p.id);

    /**
     * Every block below is scoped by these two lists and there is no unscoped
     * branch, deliberately. This endpoint used to omit the predicate entirely
     * when no personalityId was passed, on the reasoning that "all" is said
     * faster than a long IN () -- but "all" here meant every tenant, so an
     * unfiltered load returned the whole estate's spend, throughput, account
     * roster and country mix to whoever asked. The list is bounded by what one
     * client has bought (~100 accounts at the size the code plans for), not by
     * the size of the database, so the IN () costs nothing worth having.
     */
    const scopeAccounts = { accountId: { in: accountIds } };
    const personWhere: Prisma.PersonWhereInput = {
      createdAt: { gte: from, lt: toExclusive },
      personalityId: { in: personalityIds },
    };
    const sheetWhere: Prisma.SheetWhereInput = {
      receivedAt: { gte: from, lt: toExclusive },
      ...scopeAccounts,
    };
    const assignmentWhere: Prisma.AssignmentWhereInput = {
      createdAt: { gte: from, lt: toExclusive },
      ...scopeAccounts,
    };

    const sheetScope = rawScope('sh."accountId"', accountIds);
    const assignmentScope = rawScope('a."accountId"', accountIds);
    const personScope = rawScope('p."personalityId"', personalityIds);
    const fromLit = utcLiteral(from);
    const toLit = utcLiteral(toExclusive);

    const [days, accountCosts, personTargets, states, handedToday, countries, sources, models] =
      await Promise.all([
        /**
         * The calendar is generated by the database and the three per-day
         * counts are left-joined onto it, so a quiet day arrives as a row of
         * zeroes rather than as a gap. A chart that silently skips empty days
         * draws a trend that never happened, and reconstructing the calendar in
         * the browser is work the database has already done.
         *
         * Each branch groups before it joins, so no branch can fan the others
         * out. Days are UTC days, matching the range bounds below.
         */
        this.prisma.$queryRaw<DayRow[]>`
          WITH days AS (
            SELECT generate_series(${firstDay}::date, ${lastDay}::date, interval '1 day')::date AS day
          ),
          sheet_days AS (
            SELECT date_trunc('day', sh."receivedAt")::date AS day,
                   COUNT(*)::int AS sheets,
                   COALESCE(SUM(e.usd), 0)::float8 AS usd
            FROM sheets sh
            LEFT JOIN extractions e ON e."sheetId" = sh.id
            WHERE sh."receivedAt" >= ${fromLit}::timestamp
              AND sh."receivedAt" < ${toLit}::timestamp
              ${sheetScope}
            GROUP BY 1
          ),
          people_days AS (
            SELECT date_trunc('day', p."createdAt")::date AS day, COUNT(*)::int AS targets
            FROM people p
            WHERE p."createdAt" >= ${fromLit}::timestamp
              AND p."createdAt" < ${toLit}::timestamp
              ${personScope}
            GROUP BY 1
          ),
          followed_days AS (
            SELECT date_trunc('day', a."createdAt")::date AS day, COUNT(*)::int AS followed
            FROM assignments a
            WHERE a."createdAt" >= ${fromLit}::timestamp
              AND a."createdAt" < ${toLit}::timestamp
              AND a.state = 'followed'
              ${assignmentScope}
            GROUP BY 1
          )
          SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
                 COALESCE(s.sheets, 0) AS sheets,
                 COALESCE(pe.targets, 0) AS targets,
                 COALESCE(f.followed, 0) AS followed,
                 COALESCE(s.usd, 0) AS usd
          FROM days d
          LEFT JOIN sheet_days s ON s.day = d.day
          LEFT JOIN people_days pe ON pe.day = d.day
          LEFT JOIN followed_days f ON f.day = d.day
          ORDER BY d.day
        `,

        /**
         * Spend per account, which rolls up to both byPersonality and totals.
         *
         * Raw rather than a Prisma aggregate because cost lives on Extraction
         * and the account it should be billed to lives on Sheet, and groupBy
         * cannot group one model by another model's column.
         *
         * The window is applied to the SHEET's receivedAt, not the extraction's
         * createdAt: a sheet uploaded at 23:59 whose extraction lands at 00:01
         * belongs to the day it was uploaded, so its cost sits on the same
         * byDay row as the sheet it paid for.
         */
        this.prisma.$queryRaw<AccountCostRow[]>`
          SELECT sh."accountId" AS "accountId",
                 COUNT(*)::int AS sheets,
                 -- ::float8, not ::int: a busy month's token sum overflows int4,
                 -- and ::bigint arrives as a JS BigInt, which JSON.stringify
                 -- throws on rather than serialising.
                 COALESCE(SUM(e.usd), 0)::float8 AS usd,
                 COALESCE(SUM(e."profilesFound"), 0)::float8 AS "profilesRead",
                 COALESCE(SUM(e."promptTokens"), 0)::float8 AS "promptTokens",
                 COALESCE(SUM(e."completionTokens"), 0)::float8 AS "completionTokens"
          FROM sheets sh
          LEFT JOIN extractions e ON e."sheetId" = sh.id
          WHERE sh."receivedAt" >= ${fromLit}::timestamp
            AND sh."receivedAt" < ${toLit}::timestamp
            ${sheetScope}
          GROUP BY 1
        `,

        this.prisma.person.groupBy({
          by: ['personalityId'],
          where: personWhere,
          _count: { _all: true },
        }),

        // One groupBy feeds byAccount, byPersonality and totals. Asking per
        // account instead is a round trip per account per state.
        this.prisma.assignment.groupBy({
          by: ['accountId', 'state'],
          where: assignmentWhere,
          _count: { _all: true },
        }),

        // Deliberately ignores from/to. This is the live cap gauge -- what is
        // left of today -- and "handed out today" has to mean today whatever
        // window the operator is looking at. Local midnight, matching
        // TargetsService.handedOutToday.
        this.prisma.assignment.groupBy({
          by: ['accountId'],
          where: { handedOutAt: { gte: startOfToday() }, ...scopeAccounts },
          _count: { _all: true },
        }),

        /**
         * Forwarded = reached an account's queue at all. PipelineService writes
         * a forward as `queued` and every other state (handed_out, followed,
         * failed, skipped) descends from one, while a dropped person gets no
         * assignment row at all. So the existence of the row IS the answer, and
         * COUNT over the LEFT JOIN gives it in the same pass as the total --
         * this used to need a FILTER to exclude the held-for-a-human rows.
         */
        this.prisma.$queryRaw<CountryRow[]>`
          SELECT p.nationality AS nationality,
                 COUNT(*)::int AS count,
                 COUNT(a.id)::int AS forwarded
          FROM people p
          LEFT JOIN assignments a ON a."personId" = p.id
          WHERE p."createdAt" >= ${fromLit}::timestamp
            AND p."createdAt" < ${toLit}::timestamp
            ${personScope}
          GROUP BY 1
          ORDER BY 2 DESC, 1 ASC
        `,

        this.prisma.person.groupBy({
          by: ['source'],
          where: personWhere,
          _count: { _all: true },
        }),

        this.prisma.extraction.groupBy({
          by: ['model'],
          where: { sheet: sheetWhere },
          _count: { _all: true },
          _sum: { usd: true },
          _avg: { seconds: true, profilesFound: true },
        }),
      ]);

    const costByAccount = new Map(accountCosts.map((r) => [r.accountId, r]));
    const targetsByPersonality = new Map(personTargets.map((r) => [r.personalityId, r._count._all]));
    const handedByAccount = new Map(handedToday.map((r) => [r.accountId, r._count._all]));

    const stateByAccount = new Map<string, Record<string, number>>();
    const stateTotals: Record<string, number> = {};
    for (const row of states) {
      const bucket = stateByAccount.get(row.accountId) ?? {};
      bucket[row.state] = row._count._all;
      stateByAccount.set(row.accountId, bucket);
      stateTotals[row.state] = (stateTotals[row.state] ?? 0) + row._count._all;
    }

    const byAccount = personalities.flatMap((p) =>
      p.accounts.map((a) => {
        const bucket = stateByAccount.get(a.id) ?? {};
        const followed = bucket.followed ?? 0;
        const failed = bucket.failed ?? 0;
        const decided = followed + failed;
        return {
          id: a.id,
          label: a.label,
          personality: p.name,
          dailyCap: p.client.dailyCapPerAccount,
          handedToday: handedByAccount.get(a.id) ?? 0,
          followed,
          failed,
          // An account that has reported nothing yet is 0, never 0/0. NaN
          // serialises to null and the UI renders a blank where a number goes.
          successRate: decided === 0 ? 0 : followed / decided,
        };
      }),
    );

    const byPersonality = personalities.map((p) => {
      let followed = 0;
      let queued = 0;
      let usd = 0;
      let sheets = 0;
      for (const a of p.accounts) {
        const bucket = stateByAccount.get(a.id) ?? {};
        followed += bucket.followed ?? 0;
        queued += bucket.queued ?? 0;
        const cost = costByAccount.get(a.id);
        usd += cost?.usd ?? 0;
        sheets += cost?.sheets ?? 0;
      }
      return {
        id: p.id,
        name: p.name,
        targets: targetsByPersonality.get(p.id) ?? 0,
        followed,
        queued,
        usd: roundUsd(usd),
        sheets,
      };
    });

    const bySource = {
      extraction: sources.find((s) => s.source === 'extraction')?._count._all ?? 0,
      manual: sources.find((s) => s.source === 'manual')?._count._all ?? 0,
    };

    return {
      range: {
        from: from.toISOString(),
        // The instant the last day ends, so the UI renders the day the caller
        // asked for. The predicate itself is half-open on toExclusive.
        to: new Date(toExclusive.getTime() - 1).toISOString(),
      },
      totals: {
        sheets: sum(accountCosts, (r) => r.sheets),
        profilesRead: sum(accountCosts, (r) => r.profilesRead),
        targets: sum(personTargets, (r) => r._count._all),
        usd: roundUsd(sum(accountCosts, (r) => r.usd)),
        promptTokens: sum(accountCosts, (r) => r.promptTokens),
        completionTokens: sum(accountCosts, (r) => r.completionTokens),
        followed: stateTotals.followed ?? 0,
        failed: stateTotals.failed ?? 0,
        skipped: stateTotals.skipped ?? 0,
        queued: stateTotals.queued ?? 0,
        handedOut: stateTotals.handed_out ?? 0,
      },
      byDay: days,
      byPersonality,
      byAccount,
      byCountry: countries,
      bySource,
      byModel: models.map((m) => ({
        model: m.model,
        sheets: m._count._all,
        // _sum.usd is a Prisma.Decimal, which serialises as the STRING "0.12".
        // The UI does arithmetic on this field, and "0.12" + 1 is "0.121" with
        // no error anywhere, so the conversion happens here at the boundary.
        usd: Number(m._sum.usd ?? 0),
        avgSeconds: m._avg.seconds ?? 0,
        avgProfiles: m._avg.profilesFound ?? 0,
      })),
    };
  }
}

/**
 * `IN ()` is a syntax error, so an empty scope has to be spelled out as
 * "matches nothing" rather than left to the empty list. Getting this wrong
 * makes a brand new client, or a personality that owns no accounts yet, report
 * the whole estate's numbers as its own.
 */
function rawScope(column: string, ids: string[]): Prisma.Sql {
  if (ids.length === 0) return Prisma.sql`AND false`;
  return Prisma.sql`AND ${Prisma.raw(column)} IN (${Prisma.join(ids)})`;
}

/**
 * from/to are calendar days, inclusive at both ends, so `?from=X&to=X` is one
 * day rather than nothing.
 */
function resolveRange(fromRaw?: string, toRaw?: string) {
  const to = toRaw === undefined ? startOfUtcDay(new Date()) : parseDay(toRaw, 'to');
  const from =
    fromRaw === undefined
      ? new Date(to.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)
      : parseDay(fromRaw, 'from');

  if (from.getTime() > to.getTime()) {
    throw new BadRequestException('from must not be later than to');
  }
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestException(`range must not exceed ${MAX_RANGE_DAYS} days`);
  }

  return {
    from,
    toExclusive: new Date(to.getTime() + DAY_MS),
    firstDay: dayLiteral(from),
    lastDay: dayLiteral(to),
  };
}

function parseDay(raw: string, field: string): Date {
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new BadRequestException(`${field} is not a date`);
  return startOfUtcDay(new Date(parsed));
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function dayLiteral(d: Date): string {
  return d.toISOString().slice(0, 10);
}


function sum<T>(rows: T[], pick: (row: T) => number): number {
  let total = 0;
  for (const row of rows) total += pick(row);
  return total;
}

/**
 * usd is Decimal(10, 6) in the database, so anything past the sixth place is
 * float noise introduced by adding the per-account subtotals together here.
 */
function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
