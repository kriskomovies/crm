/**
 * The targeting rule: who gets forwarded to the follow queue.
 *
 * One rule per client, at position 1. The schema allows an ordered list and the
 * pipeline evaluates them in order, but nothing has ever needed a second one --
 * so the UI edits one and this endpoint upserts it rather than exposing an
 * ordering nobody uses.
 *
 * NATIONALITY IS NOT A CLOSED SET, and the attempt to make it one is what this
 * file got wrong. There used to be an `ORIGINS` constant of 16 capitalised
 * strings here, under a comment claiming the vocabulary travelled with the
 * value "so the UI never hardcodes a list that can drift". The UI never did.
 * This file did, and it drifted exactly as the comment feared.
 *
 * Measured on production (`kris agency`), the model had returned and the ledger
 * had stored: welsh 19, hebrew 3, japanese 3, romanian 2, and singletons for
 * albanian, chinese, danish, dutch, latin, lithuanian, pakistani, pashto,
 * persian. None of them were in ORIGINS, so no checkbox could ever match them
 * and PUT silently DROPPED them if you submitted them anyway. A second 112
 * people had no reading at all and were unreachable by construction.
 *
 * The closed set was never enforceable in the first place. `sheet-task.ts` asks
 * the model in as many words to answer "English" for a generic anglophone name;
 * parsing the recorded replies, the largest bucket in all three is `american`,
 * which ORIGINS did not contain, and `golden-99.reply.txt` contains the string
 * `english` zero times. The vocabulary is a property of whichever model the
 * client is configured for, not of the prompt -- so it can only come from the
 * data. Which is what `origins` below now is: distinct Person.nationality for
 * this client, with a count each, most common first.
 */
import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { NO_NATIONALITY, SKIN_TONES } from '../extraction/normalize';
import { PrismaService } from '../prisma/prisma.service';

/** One tickable origin and how many of this client's people it would match. */
export interface OriginOption {
  value: string;
  count: number;
}

export const PRESENTS = ['man', 'woman', 'ambiguous'] as const;
export const CONFIDENCES = ['low', 'medium', 'high'] as const;

/**
 * The avatar's face colour. Re-exported from the extractor's vocabulary so the
 * checkboxes can never offer a tone the extractor does not actually return.
 *
 * This one IS legitimately closed, unlike origin: normSkinTone maps every reply
 * onto these ten values or onto null, so nothing outside the list can reach the
 * column. Origin had no such normaliser -- normCountry lowercases and truncates
 * and otherwise stores whatever it was handed -- which is why that list had to
 * come from the data and this one does not.
 */
export const SKIN_TONE_OPTIONS = SKIN_TONES;

/**
 * Men, English-speaking, low bar. See the note on `low` below.
 *
 * `english` lowercase, matching what is actually stored: normCountry lowercases
 * every reading before it reaches the column, so the options this endpoint
 * serves are lowercase too. The filter folds case and so matched 'English'
 * fine, but the SCREEN compares exactly -- a capitalised default rendered as an
 * unticked `english (572)` chip on a rule that was forwarding english, which is
 * a targeting page lying about what it is targeting.
 */
export const DEFAULT_RULE = {
  presentsAs: ['man'],
  countries: ['english'],
  // Empty = any tone. Skin tone is off by default: it is a targeting knob a
  // client opts into, not a filter that should quietly narrow the queue.
  skinTones: [] as string[],
  /**
   * `low`, deliberately. Measured on the golden sheet: 80 of 99 entries come
   * back low confidence, because a first name really is weak evidence and the
   * model says so honestly. A `medium` bar therefore discards about four
   * fifths of the roster -- of 65 English-reading men, exactly ONE cleared it.
   */
  minConfidence: 'low',
  action: 'forward',
};

@ApiTags('rules')
@Controller('api/rules')
@UseGuards(ApiKeyGuard)
export class RulesController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The origins this client's extractor has ACTUALLY returned, keyed by the
   * lowercase form so a caller can canonicalise what it was sent.
   *
   * One query, no join, no time window.
   *
   *   - No window, deliberately. /api/stats has a nearly identical query at
   *     stats.service.ts:251 but it is scoped to 30 days and LEFT JOINs
   *     assignments for a `forwarded` count. A rule is not time-scoped: a
   *     nationality last seen 40 days ago must stay tickable, or the option
   *     list gains a second, subtler drift than the one this change removed.
   *   - Served by @@index([personalityId, presentsAs, nationality]) on people,
   *     the only index containing nationality. It covers every column this
   *     touches, so it is an index-only scan feeding a hash aggregate -- no
   *     heap access, no fan-out. The scan grows with the ledger, but its OUTPUT
   *     is bounded by nationality cardinality (~30 in production, ~12 in every
   *     recorded reply), which is the same "pre-aggregated bucket" trade
   *     stats.service.ts already makes and explains at its own file header.
   *   - The client scope is a relation filter rather than an id list, so
   *     clientId stays inside the predicate and there is no empty-IN case to
   *     get wrong for a client that owns no personalities yet.
   */
  private async originsFor(
    clientId: string,
    ruleCountries: readonly string[],
  ): Promise<Map<string, OriginOption>> {
    const groups = await this.prisma.person.groupBy({
      by: ['nationality'],
      where: { personality: { clientId } },
      _count: { _all: true },
    });

    const byKey = new Map<string, OriginOption>();
    let unread = 0;
    for (const g of groups) {
      // groupBy returns the nulls as their own row, so the count for the
      // sentinel arrives free from the same scan.
      if (g.nationality === null) {
        unread += g._count._all;
        continue;
      }
      // Summed, not overwritten. normCountry lowercases every reading so two
      // casings of one bucket should be impossible -- but a row written before
      // it did, or by hand, would otherwise silently lose a count here, and an
      // undercount on this screen is invisible in a way an overcount is not.
      const key = g.nationality.toLowerCase();
      const prior = byKey.get(key);
      byKey.set(key, {
        value: prior?.value ?? g.nationality,
        count: (prior?.count ?? 0) + g._count._all,
      });
    }

    // Always offered, even at zero, because it is a structural bucket rather
    // than a value the data happens to contain -- and because PUT accepts
    // exactly what this map holds, so omitting it at zero would make "target
    // the people with no reading" un-savable on a young client.
    //
    // The `?? 0` is the same defensive sum: normCountry cannot store the string
    // 'none' (that is the whole basis of the sentinel, and extraction.spec
    // guards it), so nothing should be under this key yet.
    //
    // A client whose rule still holds the legacy 'unknown' gets that as a
    // SEPARATE option, unioned in below at count 0 -- which is the true count,
    // because no person holds it and it matches nobody. That is the deploy
    // contract: the old inert tick keeps forwarding exactly nobody and is now
    // marked as doing so, instead of quietly acquiring 112 people.
    byKey.set(NO_NATIONALITY, {
      value: NO_NATIONALITY,
      count: unread + (byKey.get(NO_NATIONALITY)?.count ?? 0),
    });

    // Union in whatever the rule already holds. A nationality that stops
    // appearing in new sheets must not silently vanish from the rule still
    // using it: the option would disappear from the screen while the filter
    // went on honouring it, so the page would misreport who is being targeted.
    // Count 0 is the honest number -- nobody in the ledger matches it today.
    for (const c of ruleCountries) {
      const key = c.trim().toLowerCase();
      if (key && !byKey.has(key)) byKey.set(key, { value: key, count: 0 });
    }
    return byKey;
  }

  @Get()
  async get(@Req() req: any) {
    const rule = await this.prisma.filterRule.findFirst({
      where: { clientId: req.client.id },
      orderBy: { position: 'asc' },
    });
    // The DEFAULT_RULE's countries are unioned in too, not just a saved rule's.
    // A brand new client is shown that default and must be able to save it back
    // unchanged; without this its very first save would 400 on `english`.
    const saved = rule ?? { ...DEFAULT_RULE, enabled: true };
    const byKey = await this.originsFor(req.client.id, saved.countries);

    return {
      // The vocabulary travels with the value, and now it is the client's own
      // data rather than a constant in this file pretending to be it.
      options: {
        origins: sortOrigins(byKey),
        presentsAs: PRESENTS,
        confidences: CONFIDENCES,
        skinTones: SKIN_TONE_OPTIONS,
      },
      rule: {
        presentsAs: saved.presentsAs,
        // Canonicalised to the option values so the two halves of this response
        // can never disagree. The screen ticks a chip by comparing strings, so
        // a rule holding legacy 'English' beside an option reading 'english'
        // renders as untargeted while the filter targets it. Storage catches up
        // on the next save; the screen must not have to wait for it.
        countries: canonicalise(saved.countries, byKey),
        skinTones: saved.skinTones,
        minConfidence: saved.minConfidence,
        action: saved.action,
        enabled: saved.enabled,
      },
    };
  }

  @Put()
  async put(
    @Req() req: any,
    @Body()
    body: {
      presentsAs?: string[];
      countries?: string[];
      skinTones?: string[];
      minConfidence?: string;
      enabled?: boolean;
    },
  ) {
    const presentsAs = (body.presentsAs ?? []).filter((p) =>
      (PRESENTS as readonly string[]).includes(p),
    );

    /**
     * Countries are validated against this client's own data, plus whatever the
     * rule already holds -- and a value that survives neither is a 400 NAMING
     * it, not a silent omission.
     *
     * The old line was `.filter(c => ORIGINS.includes(c))`. Submitting `welsh`
     * -- a value the model really returns, 19 people in production -- saved a
     * rule without it and answered `{ saved: true }`. The screen then showed
     * the box unticked, which reads as "the click did not register", so the
     * operator ticks it again. There is no number of attempts that works and
     * nothing anywhere says why.
     */
    const existing = await this.prisma.filterRule.findFirst({
      where: { clientId: req.client.id },
      orderBy: { position: 'asc' },
      select: { countries: true },
    });
    const byKey = await this.originsFor(
      req.client.id,
      existing?.countries ?? DEFAULT_RULE.countries,
    );
    const countries: string[] = [];
    for (const raw of body.countries ?? []) {
      const option = byKey.get(String(raw).trim().toLowerCase());
      if (!option) {
        // Names the offender and says what the list is made of, because the
        // answer to "why not?" is never guessable from a generic 400: the
        // vocabulary is whatever THIS client's model has returned so far.
        throw new BadRequestException(
          `country "${raw}" is not one this client's extractor has returned, ` +
            `and is not already saved on the rule; choose from: ` +
            sortOrigins(byKey)
              .map((o) => o.value)
              .join(', ') +
            // The sentinel is the one value in that list that is not a
            // nationality, and it reads like the word for "no selection" --
            // which is the opposite of what it does. Named here because this
            // message is the only place a caller outside the browser meets it.
            ` ("${NO_NATIONALITY}" targets the people whose nationality was never read)`,
        );
      }
      // Deduped and canonicalised. Ticking `english` when the rule already
      // holds `English` must not save the same bucket twice.
      if (!countries.includes(option.value)) countries.push(option.value);
    }

    const skinTones = (body.skinTones ?? []).filter((t) =>
      (SKIN_TONE_OPTIONS as readonly string[]).includes(t),
    );
    const minConfidence = (CONFIDENCES as readonly string[]).includes(
      body.minConfidence ?? '',
    )
      ? body.minConfidence!
      : 'low';

    const rule = await this.prisma.filterRule.upsert({
      where: { clientId_position: { clientId: req.client.id, position: 1 } },
      update: { presentsAs, countries, skinTones, minConfidence, enabled: body.enabled ?? true },
      create: {
        clientId: req.client.id,
        position: 1,
        presentsAs,
        countries,
        skinTones,
        minConfidence,
        action: 'forward',
        enabled: body.enabled ?? true,
      },
    });

    return {
      saved: true,
      rule: {
        presentsAs: rule.presentsAs,
        countries: rule.countries,
        skinTones: rule.skinTones,
        minConfidence: rule.minConfidence,
        action: rule.action,
        enabled: rule.enabled,
      },
      // An empty country list means "any", not "none" -- worth saying, because
      // the two read identically in a UI full of unchecked boxes.
      note: countries.length
        ? undefined
        : 'no countries selected: every origin is forwarded',
    };
  }
}

/**
 * Most common first, ties broken alphabetically so the list is stable between
 * two loads that happen to have equal counts.
 *
 * The whole point of the counts is that `welsh (19)` answers "is this worth
 * ticking" without leaving the page, and ordering by count is what puts the
 * answer at the top. The sentinel sorts by its count like anything else -- on
 * the client that prompted this it is 112, and second.
 */
function sortOrigins(byKey: Map<string, OriginOption>): OriginOption[] {
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.value.localeCompare(b.value),
  );
}

/**
 * Rewrite a saved rule's countries into the option values they match.
 *
 * Every entry is guaranteed to resolve, because originsFor() unioned this exact
 * list in; the `?? c` is for a value made of nothing but whitespace, which
 * originsFor skips and which no honest rule holds.
 */
function canonicalise(
  countries: readonly string[],
  byKey: Map<string, OriginOption>,
): string[] {
  const out: string[] = [];
  for (const c of countries) {
    const value = byKey.get(c.trim().toLowerCase())?.value ?? c;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
