/**
 * The pipeline: extract -> resolve -> filter -> allocate.
 *
 * Runs in the worker, never in the request path, because one extraction holds
 * an HTTP call open for 45-75 seconds.
 *
 * The stages are separate methods rather than one function so that `filter` and
 * `allocate` can be replayed over already-extracted rows. When a client edits
 * their country list we re-decide stored people instead of re-paying for
 * vision, which at $0.74/1000 profiles is the difference between a free rule
 * change and an expensive one.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AssignmentState, Prisma, SheetStatus } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';

import { GatewayClient } from '../extraction/gateway.client';
import { priceUsd } from '../extraction/pricing';
import {
  cleanDisplayName,
  combinePresents,
  confidenceAtLeast,
  isPlausibleHandle,
  normCountry,
  normHandle,
  presentsToDb,
  signalsDisagree,
  toPresents,
} from '../extraction/normalize';
import {
  distinctCuesRatio,
  extractJson,
  RawEntry,
  sheetPrompt,
} from '../extraction/sheet-task';
import { PrismaService } from '../prisma/prisma.service';
import { RetentionService } from '../retention/retention.service';
import { StorageService } from '../storage/storage.service';

/**
 * Below this share of distinct avatar descriptions the model has stopped
 * reading pixels and is filling in a template. Measured: gemini-3.6-flash
 * scores 1.0, gpt-4.1-mini scored 0.04 while labelling everything "man".
 */
const MIN_DISTINCT_CUES = 0.25;

/** How many profiles a full contact sheet is expected to contain. */
const SHEET_ENTRIES = 99;

@Injectable()
export class PipelineService {
  private readonly log = new Logger(PipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly gateway: GatewayClient,
    private readonly retention: RetentionService,
  ) {}

  async run(sheetId: string): Promise<void> {
    const sheet = await this.prisma.sheet.findUniqueOrThrow({
      where: { id: sheetId },
      include: { account: { include: { personality: { include: { client: true } } } } },
    });
    const client = sheet.account.personality.client;

    await this.prisma.sheet.update({
      where: { id: sheetId },
      data: { status: 'extracting' },
    });

    if (!sheet.storageKey) {
      // Retention removed the image before this job ran. It only prunes sheets
      // in a terminal status, so reaching here means the row was re-queued
      // after being pruned -- there is nothing to send the model, and failing
      // loudly beats a confusing gateway error about an empty image.
      await this.prisma.sheet.update({
        where: { id: sheetId },
        data: { status: 'failed', error: 'image deleted by retention' },
      });
      return;
    }

    try {
      const entries = await this.extract(sheetId, sheet.storageKey, client);
      const people = await this.resolve(sheet.account.personalityId, sheetId, entries);
      const decisions = await this.filter(
        client.id,
        people.map((p) => p.id),
      );
      // A near duplicate never goes straight out, whatever the rules say: it may
      // be the same human already assigned under a slightly different handle.
      //
      // Driven from the flagged people, not from the decisions. Walking the
      // decisions only ever reached a person some rule had already matched, so
      // the verdict was dropped for everyone else -- and "everyone else" is the
      // common case, not a corner: a reply that carries no gender reading
      // combines to 'ambiguous', matches no rule, and produces no decision at
      // all. The twin was then stored, flagged, and silently forgotten, with no
      // assignment row on either the queue or the review screen. Nothing
      // downstream can recover it: the verdict lives only in this variable, so
      // the free replay of filter+allocate after a rule change would queue both
      // rows and follow one man twice. UNIQUE (personId) cannot catch that --
      // they are two distinct Person rows, which is precisely what was noticed.
      const byPerson = new Map(decisions.map((d) => [d.personId, d]));
      for (const p of people) {
        if (!p.nearDuplicateOf) continue;
        const reason = `looks like @${p.nearDuplicateOf} read differently — confirm before following`;
        const decided = byPerson.get(p.id);
        if (decided) {
          decided.action = 'review';
          decided.reason = reason;
        } else {
          decisions.push({ personId: p.id, action: 'review', reason });
        }
      }
      await this.allocate(sheet.accountId, decisions);

      // Everything that will ever read this image has now read it. Not after
      // extract() returns -- resolve, filter and allocate are still to come,
      // and a throw in any of them retries the whole job from the top with
      // another getDataUri on this key.
      await this.retention.onPipelineComplete(sheetId, sheet.storageKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`sheet ${sheetId} failed: ${message}`);
      // Never over a status extract() already decided on. It marks a templated
      // reply 'rejected' -- the one status the schema defines for "the model
      // stopped reading pixels" -- and then throws to stop the pipeline;
      // overwriting that with 'failed' made SheetStatus.rejected unreachable
      // and threw away the measured ratio in its error text. updateMany so a
      // no-op match is not itself an error.
      await this.prisma.sheet.updateMany({
        where: { id: sheetId, status: { not: 'rejected' } },
        data: { status: 'failed', error: message.slice(0, 500) },
      });
      throw err;
    }
  }

  /** One VLM call. Persists tokens, cost and the raw reply verbatim. */
  private async extract(
    sheetId: string,
    storageKey: string,
    client: { id: string; extractionModel: string },
  ): Promise<RawEntry[]> {
    const image = await this.storage.getDataUri(storageKey);
    const result = await this.gateway.ask({
      model: client.extractionModel,
      prompt: sheetPrompt(SHEET_ENTRIES),
      images: [image],
    });

    const { entries, salvaged } = extractJson(result.text);
    const cuesRatio = distinctCuesRatio(entries);

    // A templated reply is worse than no reply: it is confident, well-formed,
    // and wrong, and nothing downstream can detect it. Refuse it here.
    const templated = cuesRatio !== null && cuesRatio < MIN_DISTINCT_CUES;
    const status: SheetStatus = templated
      ? 'rejected'
      : entries.length === 0
        ? 'failed'
        : salvaged || entries.length < SHEET_ENTRIES
          ? 'partial'
          : 'extracted';
    const error = templated
      ? `templated avatar descriptions (${cuesRatio!.toFixed(2)} distinct) — model not reading the image`
      : entries.length === 0
        ? 'no entries parsed from the reply'
        : null;

    // The cost row and the status move together. As two statements a crash in
    // between left the sheet in 'extracting' with nothing to move it on: the
    // status is what the client polls, and a re-upload cannot rescue it either
    // because UNIQUE (accountId, sha256) just hands back the same stuck job.
    await this.prisma.$transaction([
      this.prisma.extraction.upsert({
        where: { sheetId },
        create: {
          sheetId,
          model: client.extractionModel,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          usd: new Prisma.Decimal(
            priceUsd(client.extractionModel, result.promptTokens, result.completionTokens),
          ),
          seconds: result.seconds,
          rawReply: result.text as unknown as Prisma.InputJsonValue,
          profilesFound: entries.length,
          distinctCuesRatio: cuesRatio,
        },
        update: {},
      }),
      // error is cleared, not left, so a retry that succeeds does not keep
      // reporting the reason the previous attempt failed.
      this.prisma.sheet.update({ where: { id: sheetId }, data: { status, error } }),
    ]);

    if (templated) {
      // Unrecoverable, so BullMQ stops here. The verdict is deterministic --
      // same image, same model, same templated reply -- and the three default
      // retries would each buy another vision call to reach it again.
      throw new UnrecoverableError('extraction rejected: templated output');
    }
    // A truncated reply is not deterministic, so this one is worth retrying.
    if (entries.length === 0) throw new Error('no entries parsed from the reply');

    return entries;
  }

  /**
   * Fold a sheet's entries into the per-personality ledger.
   *
   * `UNIQUE (personalityId, handle)` does the dedupe, so three of a
   * personality's accounts uploading overlapping lists concurrently converge on
   * one row without any application-level locking. A person already known just
   * has timesSeen bumped and never re-enters the queue.
   */
  private async resolve(
    personalityId: string,
    sheetId: string,
    entries: RawEntry[],
  ): Promise<{ id: string; isNew: boolean; nearDuplicateOf?: string | null }[]> {
    // First occurrence of a handle wins. A sheet that lists someone twice is
    // still one person, and the row-at-a-time version bumped timesSeen twice
    // for it.
    const rows = new Map<string, Prisma.PersonCreateManyInput>();
    for (const e of entries) {
      const handle = normHandle(e.handle);
      // An invented handle is far more damaging than a dropped one: it enters
      // the ledger, gets assigned, and the account tries to follow a person who
      // does not exist. Nothing downstream can tell it was hallucinated.
      if (!isPlausibleHandle(handle) || rows.has(handle)) continue;

      const avatar = toPresents(e.avatar_presents_as);
      const name = toPresents(e.name_presents_as ?? e.presents_as);
      rows.set(handle, {
        personalityId,
        handle,
        firstSeenSheetId: sheetId,
        displayName: cleanDisplayName(e.display_name),
        presentsAs: presentsToDb(combinePresents(avatar, name)) as any,
        avatarPresentsAs: presentsToDb(avatar) as any,
        namePresentsAs: presentsToDb(name) as any,
        nationality: normCountry(e.nationality),
        nationalityConf: (e.nationality_confidence ?? '').toLowerCase() || null,
        avatarCues: e.cues ?? null,
      });
    }
    if (rows.size === 0) return [];

    // Four statements for the whole sheet. Per entry this was a findUnique, an
    // update or upsert, and a near-duplicate query -- about 300 sequential
    // round trips for a 99-entry sheet, each one a full latency to the
    // database, in a job that already holds the gateway open for a minute.
    const handles = [...rows.keys()];
    const before = new Map(
      (
        await this.prisma.person.findMany({
          where: { personalityId, handle: { in: handles } },
          select: { id: true, handle: true },
        })
      ).map((p) => [p.handle, p.id]),
    );
    const fresh = handles.filter((h) => !before.has(h));

    // Read before the inserts, so a new handle is compared against the ledger
    // as it stood and then, in order, against the earlier new handles of this
    // same sheet -- which is what the row-at-a-time version compared against.
    // Both readings of one person can arrive in a single extraction.
    const candidates = await this.nearDuplicateCandidates(
      personalityId,
      fresh.map((h) => rows.get(h)!.displayName),
    );

    if (before.size) {
      await this.prisma.person.updateMany({
        where: { personalityId, handle: { in: [...before.keys()] } },
        data: { timesSeen: { increment: 1 } },
      });
    }

    const created = new Map<string, string>();
    if (fresh.length) {
      // skipDuplicates is ON CONFLICT DO NOTHING on (personalityId, handle):
      // three of a personality's accounts uploading overlapping lists at once
      // still converge on one row, with no application-level locking. The one
      // thing it gives up on that race is the timesSeen bump for a handle a
      // sibling inserted in the gap -- an advisory counter, against 300 round
      // trips.
      await this.prisma.person.createMany({
        data: fresh.map((h) => rows.get(h)!),
        skipDuplicates: true,
      });
      for (const p of await this.prisma.person.findMany({
        where: { personalityId, handle: { in: fresh } },
        select: { id: true, handle: true },
      })) {
        created.set(p.handle, p.id);
      }
    }

    const out: { id: string; isNew: boolean; nearDuplicateOf?: string | null }[] = [];
    for (const handle of handles) {
      const known = before.get(handle);
      if (known) {
        out.push({ id: known, isNew: false, nearDuplicateOf: null });
        continue;
      }
      const id = created.get(handle);
      if (!id) continue; // deleted between the insert and the read back
      const displayName = rows.get(handle)!.displayName;
      const twin = nearDuplicate(handle, displayName, candidates);
      candidates.push({ handle, displayName });
      out.push({ id, isNew: true, nearDuplicateOf: twin });
    }
    return out;
  }

  /**
   * Everyone in this personality already carrying one of the display names
   * about to be inserted.
   *
   * One query per sheet, where there used to be one per new handle. It is also
   * strictly more correct than what it replaces, which took 200 rows sharing a
   * three-character handle prefix with no ORDER BY: once a personality held
   * more than 200 handles on a common prefix -- "mar", "jos" -- the real twin
   * simply stopped being in the sample, silently and non-deterministically, and
   * the duplicate follow the guard exists to prevent came back. Narrowing on
   * the display name instead loses nothing, because a match below requires the
   * display names to be equal anyway.
   */
  private async nearDuplicateCandidates(personalityId: string, displayNames: string[]) {
    const names = [...new Set(displayNames.filter(Boolean))];
    if (names.length === 0) return [];
    return this.prisma.person.findMany({
      where: { personalityId, displayName: { in: names } },
      select: { handle: true, displayName: true },
    });
  }

  /**
   * Apply the client's ordered rules. Everything is stored either way -- a
   * rejected person stays in the ledger so a later rule change can pick them
   * up without another model call.
   */
  async filter(
    clientId: string,
    personIds: string[],
  ): Promise<{ personId: string; action: 'forward' | 'review'; reason: string }[]> {
    const rules = await this.prisma.filterRule.findMany({
      where: { clientId, enabled: true },
      orderBy: { position: 'asc' },
    });
    const people = await this.prisma.person.findMany({
      where: { id: { in: personIds } },
    });

    const decisions: { personId: string; action: 'forward' | 'review'; reason: string }[] = [];
    for (const p of people) {
      const avatar = toPresents(fromDb(p.avatarPresentsAs));
      const name = toPresents(fromDb(p.namePresentsAs));

      // A conflict between the two signals is never a forward. This is the rule
      // that keeps a woman with a male-reading display name out of a men-only
      // feed; it costs one review item and prevents the worst outcome.
      if (signalsDisagree(avatar, name)) {
        decisions.push({
          personId: p.id,
          action: 'review',
          reason: `avatar reads ${avatar}, name reads ${name}`,
        });
        continue;
      }

      for (const rule of rules) {
        const presents = fromDb(p.presentsAs);
        if (rule.presentsAs.length && !rule.presentsAs.includes(presents)) continue;
        if (rule.countries.length && !(p.nationality && rule.countries.includes(p.nationality))) {
          continue;
        }
        if (!confidenceAtLeast(p.nationalityConf, rule.minConfidence)) {
          decisions.push({
            personId: p.id,
            action: 'review',
            reason: `country confidence ${p.nationalityConf ?? 'none'} below ${rule.minConfidence}`,
          });
          break;
        }
        if (rule.action === 'forward') {
          decisions.push({
            personId: p.id,
            action: 'forward',
            reason: `${presents}, ${p.nationality}`,
          });
        } else if (rule.action === 'review') {
          decisions.push({ personId: p.id, action: 'review', reason: 'rule' });
        }
        break; // first matching rule wins
      }
    }
    return decisions;
  }

  /**
   * Give each accepted person to exactly one account.
   *
   * The person is assigned to the account that SAW them, because Quick Add is
   * per-account: another of the personality's accounts may not have them in its
   * list at all. `UNIQUE (personId)` means a sibling account that already holds
   * them makes this a no-op, which is the dedupe guarantee the product sells.
   * Overflow past the daily cap stays queued for tomorrow rather than spilling.
   */
  async allocate(
    accountId: string,
    decisions: { personId: string; action: 'forward' | 'review'; reason: string }[],
  ): Promise<number> {
    // Two statements, not one per decision. skipDuplicates is ON CONFLICT DO
    // NOTHING against UNIQUE (personId) -- the same collision the per-row
    // version caught P2002 from and ignored, because a person a sibling account
    // already holds is the dedupe working rather than an error. The split by
    // state is what keeps the returned count honest: it has to be the number of
    // rows that really entered the queue, not the number offered.
    const rows = (action: 'forward' | 'review') =>
      decisions
        .filter((d) => d.action === action)
        .map((d) => ({
          personId: d.personId,
          accountId,
          state: (action === 'forward' ? 'queued' : 'review') as AssignmentState,
          reason: d.reason,
        }));

    const forward = rows('forward');
    const review = rows('review');
    const queued = forward.length
      ? (await this.prisma.assignment.createMany({ data: forward, skipDuplicates: true })).count
      : 0;
    if (review.length) {
      await this.prisma.assignment.createMany({ data: review, skipDuplicates: true });
    }
    return queued;
  }
}

/**
 * Prisma enums cannot contain a hyphen, so the column spells it
 * `not_a_person`, while a client's rule list and every other comparison here
 * use the hyphenated form. `.replace('_', '-')` only replaced the first
 * underscore, which left `not-a_person` -- a value no rule can ever match.
 */
function fromDb(v: string): string {
  return v.replace(/_/g, '-');
}

/**
 * The existing handle that is one character away from this one, if any.
 *
 * Exact-match dedupe is not enough on its own. Two independent extractions of
 * the SAME image produced `timetgotawatch` and `timetogotawatch` for the same
 * person -- one dropped an `o`. Left alone that is two ledger rows for one
 * human, and if they match the filter, two accounts are told to follow him:
 * exactly the duplicate this product exists to prevent.
 *
 * It does NOT auto-merge, and that restraint is deliberate. `kadenm_o6` and
 * `kadenm_06` are also one character apart and are plausibly two different
 * real accounts -- the o/0 pair is the single hardest glyph in this font.
 * Merging on distance alone would silently fuse two people. So a near
 * duplicate is routed to review and a human decides.
 *
 * An identical display name is required, not merely preferred: it is what makes
 * "same person, misread once" more likely than "two accounts that happen to
 * differ by one character". A blank display name is therefore not evidence of
 * anything and cannot match.
 */
function nearDuplicate(
  handle: string,
  displayName: string,
  candidates: { handle: string; displayName: string }[],
): string | null {
  // Under four characters nearly every handle is one edit from every other.
  if (handle.length < 4 || !displayName) return null;
  const prefix = handle.slice(0, 3);
  for (const c of candidates) {
    if (c.handle === handle) continue;
    if (c.displayName !== displayName) continue;
    if (!c.handle.startsWith(prefix)) continue;
    if (Math.abs(c.handle.length - handle.length) > 1) continue;
    if (editDistanceAtMost1(c.handle, handle)) return c.handle;
  }
  return null;
}

/**
 * True when `a` and `b` differ by at most one insert, delete or substitution.
 *
 * Bounded rather than a full Levenshtein: the only question here is "could one
 * of these be a single-character misreading of the other", and answering it
 * with an early exit keeps the ledger insert path cheap.
 */
export function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;

  let i = 0;
  let j = 0;
  let seenDifference = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (seenDifference) return false;
    seenDifference = true;
    if (short.length === long.length) i++; // substitution
    j++; // insertion in the longer string
  }
  return true;
}
