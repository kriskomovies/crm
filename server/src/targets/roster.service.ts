/**
 * One question, asked about the people actually on screen.
 *
 * The agent photographs a roster of about a hundred, uploads it, and then has to
 * decide what to do with every row in front of it. Until now it asked two
 * separate questions that were both about the LEDGER rather than about that
 * screen: "give me N targets" answered with the newest N queued, and "who may I
 * hide" answered with the newest 500 unassigned. Neither list is the roster, so
 * rows fell between them -- measured on 2026-08-19, eleven people sat on screen
 * offering Add, every one of them queued to the very account looking at them, at
 * ledger ranks 739-807 while the rows being added sat at 336-351. They were
 * never claimed, because seven hundred newer people queue ahead of them; never
 * hidden, because refusedHandles excludes anyone assigned to this account; and
 * never reported, because nothing happened to them.
 *
 * So this asks the only question that matters. Here are the hundred I can see --
 * what do I do with each? Three answers, and every handle gets exactly one:
 *
 *   add     they passed the filter and nobody has them. Charged to today's cap
 *           here and now, exactly as a claim charges it, because that is what an
 *           add is.
 *   reject  this account can never add them, or already has: the filter dropped
 *           them, a sibling holds them, THIS account already followed them, or
 *           the row was reported unfollowable. All four are terminal, so the row
 *           is swiped off rather than left to be re-read every cycle for the
 *           life of the account.
 *   leave   only two, and neither is terminal: the ledger has never heard of
 *           them (they were on the roster before any sheet carried them), or
 *           today's cap is spent. Both are rows to come back to, and hiding
 *           either would destroy a target this account still wants.
 *
 * The cap is the only reason `leave` exists for a person who would otherwise be
 * `add`. A young account stops accepting adds at roughly forty a day, so the
 * budget is the thing keeping it alive; when it runs out the honest answer is
 * "not today", and the operator's machine closes that emulator and moves to the
 * next.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { startOfToday, utcLiteral } from '../common/day';
import { entriesFrom, extractJson } from '../extraction/sheet-task';
import { normHandle } from '../extraction/normalize';
import { PrismaService } from '../prisma/prisma.service';

export type Verdict = 'add' | 'reject' | 'leave';

export interface RosterVerdict {
  handle: string;
  do: Verdict;
  /** Why, in the operator's words. Served to the machine and logged by it. */
  why: string;
}

export interface RosterAnswer {
  verdicts: RosterVerdict[];
  remainingToday: number;
  remainingInWindow: number;
  sessionWindowMinutes: number;
}

/** A roster is about a hundred rows; this bounds a caller that says otherwise. */
const MAX_ROSTER = 400;

@Injectable()
export class RosterService {
  private readonly log = new Logger(RosterService.name);

  constructor(private readonly prisma: PrismaService) {}


  /**
   * Every handle the model read off one sheet.
   *
   * The agent uploaded that screenshot and this server already read it, at full
   * size, with a vision model. Asking the agent to OCR the same rows again --
   * 9px text through Tesseract, on the machine where that has been the weakest
   * link all along -- to name people already named here is duplicated work and
   * a second place for the two to disagree about who was on screen.
   *
   * Read back out of the stored reply rather than from a column, because the
   * reply IS the record of what was on that sheet and nothing else has to be
   * kept in step with it. `people` cannot answer this: firstSeenSheetId marks
   * only those the sheet introduced, so a roster full of faces the ledger
   * already knew would come back nearly empty.
   */
  async handlesOnSheet(accountId: string, jobId?: string): Promise<string[]> {
    if (!jobId) return [];
    const sheet = await this.prisma.sheet.findFirst({
      where: { id: jobId, accountId },
      select: { extraction: { select: { rawReply: true } } },
    });
    if (!sheet) throw new NotFoundException('job not found for this account');
    const raw = sheet.extraction?.rawReply;
    if (raw == null) return [];
    // rawReply is whatever the gateway returned: the reply text, or the parsed
    // object when the provider handed one back. extractJson takes the string
    // case, entriesFrom the object case, and both end at the same list.
    const entries =
      typeof raw === 'string' ? extractJson(raw).entries : entriesFrom(raw);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const h = normHandle(e.handle);
      if (h && !seen.has(h)) {
        seen.add(h);
        out.push(h);
      }
    }
    return out;
  }

  async decide(accountId: string, handles: string[]): Promise<RosterAnswer> {
    const asked = [
      ...new Set(
        handles
          .map((h) => (h ?? '').trim().replace(/^@/, '').toLowerCase())
          .filter(Boolean),
      ),
    ].slice(0, MAX_ROSTER);

    const since = utcLiteral(startOfToday());

    return this.prisma.$transaction(async (tx) => {
      // The same lock the claim takes, and for the same reason: everything below
      // meters a budget and then spends it, so two cycles of one account must
      // not both read the room and both take it.
      const [account] = await tx.$queryRaw<
        {
          personalityId: string;
          dailyCap: number;
          sessionCap: number;
          windowMinutes: number;
          enabled: boolean;
        }[]
      >`
        SELECT a."personalityId" AS "personalityId",
               c."dailyCapPerAccount" AS "dailyCap",
               c."sessionCapPerAccount" AS "sessionCap",
               c."sessionWindowMinutes" AS "windowMinutes",
               a.enabled
        FROM accounts a
        JOIN personalities p ON p.id = a."personalityId"
        JOIN clients c ON c.id = p."clientId"
        WHERE a.id = ${accountId}
        FOR UPDATE OF a
      `;
      if (!account) throw new NotFoundException('account not found');

      const [used] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM assignments
        WHERE "accountId" = ${accountId} AND "handedOutAt" >= ${since}::timestamp
      `;
      const [inWindow] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM assignments
        WHERE "accountId" = ${accountId}
          AND "handedOutAt" >= (NOW() AT TIME ZONE 'UTC')
                               - make_interval(mins => ${account.windowMinutes}::int)
      `;

      const roomToday = Math.max(0, account.dailyCap - used.n);
      const roomInWindow = Math.max(0, account.sessionCap - inWindow.n);
      let room = account.enabled ? Math.min(roomToday, roomInWindow) : 0;

      // One query for the whole roster rather than one per handle: a hundred
      // sequential round trips is how the old per-row version of this cost more
      // than the extraction did.
      const people = await tx.person.findMany({
        where: { personalityId: account.personalityId, handle: { in: asked } },
        select: {
          id: true,
          handle: true,
          assignment: { select: { id: true, accountId: true, state: true } },
        },
      });
      const known = new Map(people.map((p) => [p.handle, p]));

      const verdicts: RosterVerdict[] = [];
      const toHandOut: string[] = [];

      for (const handle of asked) {
        const person = known.get(handle);
        if (!person) {
          // On the roster before any sheet carried them. The next extraction
          // decides; guessing now is how a person the filter would have kept
          // gets swiped away for good.
          verdicts.push({ handle, do: 'leave', why: 'not extracted yet' });
          continue;
        }
        const a = person.assignment;
        if (!a) {
          verdicts.push({ handle, do: 'reject', why: 'dropped by the filter' });
          continue;
        }
        if (a.accountId !== accountId) {
          verdicts.push({
            handle,
            do: 'reject',
            why: 'a sibling account of this personality already holds them',
          });
          continue;
        }
        // HIDDEN, not left. Both of these are terminal for this account, and a
        // row left alone is not neutral: Quick Add goes on offering it, every
        // cycle pays to read it again, and it holds a slot on screen that a
        // workable person could have had. An operator looking at the roster
        // sees Add and X both untapped and cannot tell it from a row the
        // machine failed on.
        //
        // Hiding is irreversible -- Snapchat never suggests a hidden account
        // again -- which is exactly why it is safe HERE and nowhere else in
        // this method. Already followed: the relationship exists, so there is
        // nothing left to be suggested for. Skipped: the row can never be
        // added, so being offered it again buys nothing.
        //
        // The two `leave` answers below stay `leave` for the opposite reason.
        // A spent budget is a row to come back to tomorrow, and an unextracted
        // person is one the filter has not judged yet -- hiding either would
        // destroy a target this account still wants.
        if (a.state === 'followed') {
          verdicts.push({ handle, do: 'reject', why: 'this account already followed them' });
          continue;
        }
        if (a.state === 'skipped') {
          verdicts.push({ handle, do: 'reject', why: 'reported unfollowable' });
          continue;
        }
        // queued, handed_out or a failure that requeued: all of them mean this
        // account is meant to have this person and does not yet.
        if (room <= 0) {
          verdicts.push({
            handle,
            do: 'leave',
            why: account.enabled ? "today's budget is spent" : 'this account is paused',
          });
          continue;
        }
        room -= 1;
        toHandOut.push(a.id);
        verdicts.push({ handle, do: 'add', why: 'queued to this account' });
      }

      // Charged exactly as a claim charges it, in the same transaction that
      // decided it. An `add` the machine never presses comes back as a report,
      // and one it never reports at all is caught by the handout TTL.
      if (toHandOut.length) {
        // Prisma, not raw SQL: the raw path has to write NOW() AT TIME ZONE
        // 'UTC' by hand because handedOutAt is a timestamp WITHOUT time zone
        // holding UTC, and a bare NOW() lands in the session's zone. A Date sent
        // through Prisma is already UTC, which is the whole reason that comment
        // exists on the claim's version of this.
        await tx.assignment.updateMany({
          where: { id: { in: toHandOut } },
          data: { state: 'handed_out', handedOutAt: new Date() },
        });
      }

      return {
        verdicts,
        remainingToday: Math.max(0, roomToday - toHandOut.length),
        remainingInWindow: Math.max(0, roomInWindow - toHandOut.length),
        sessionWindowMinutes: account.windowMinutes,
      };
    });
  }
}
