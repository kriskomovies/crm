/**
 * The targeting rule: who gets forwarded to the follow queue.
 *
 * One rule per client, at position 1. The schema allows an ordered list and the
 * pipeline evaluates them in order, but nothing has ever needed a second one --
 * so the UI edits one and this endpoint upserts it rather than exposing an
 * ordering nobody uses.
 *
 * NATIONALITY is a closed set on purpose. It used to be free text, which cannot
 * back a checkbox list: the model returned "Norse" and "Arabic" on one sheet and
 * something else on the next. `english` is one bucket rather than four because
 * three runs over the real 99-profile sheet put 64-66 names in it and named a
 * specific anglophone country for at most 7 -- British once, Australian never.
 * A name does not distinguish Manchester from Melbourne.
 */
import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { SKIN_TONES } from '../extraction/normalize';
import { PrismaService } from '../prisma/prisma.service';

/** What the model is now asked to answer with, and therefore what can be filtered. */
export const ORIGINS = [
  'English',
  'Italian',
  'Spanish',
  'Portuguese',
  'French',
  'German',
  'Greek',
  'Hungarian',
  'Scottish',
  'Irish',
  'Turkish',
  'Arabic',
  'Indian',
  'Ethiopian',
  'Norse',
  'unknown',
] as const;

export const PRESENTS = ['man', 'woman', 'ambiguous'] as const;
export const CONFIDENCES = ['low', 'medium', 'high'] as const;

/**
 * The avatar's face colour. Re-exported from the extractor's vocabulary so the
 * checkboxes can never offer a tone the extractor does not actually return --
 * the same guarantee ORIGINS gives for name origin.
 */
export const SKIN_TONE_OPTIONS = SKIN_TONES;

/** Men, English-speaking, low bar. See the note on `low` below. */
export const DEFAULT_RULE = {
  presentsAs: ['man'],
  countries: ['English'],
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

  @Get()
  async get(@Req() req: any) {
    const rule = await this.prisma.filterRule.findFirst({
      where: { clientId: req.client.id },
      orderBy: { position: 'asc' },
    });
    return {
      // The vocabulary travels with the value so the UI never hardcodes a list
      // that can drift out of step with what the extractor actually returns.
      options: {
        origins: ORIGINS,
        presentsAs: PRESENTS,
        confidences: CONFIDENCES,
        skinTones: SKIN_TONE_OPTIONS,
      },
      rule: rule
        ? {
            presentsAs: rule.presentsAs,
            countries: rule.countries,
            skinTones: rule.skinTones,
            minConfidence: rule.minConfidence,
            action: rule.action,
            enabled: rule.enabled,
          }
        : { ...DEFAULT_RULE, enabled: true },
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
    const countries = (body.countries ?? []).filter((c) =>
      (ORIGINS as readonly string[]).includes(c),
    );
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
