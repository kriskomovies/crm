/**
 * The list a brand-new account is seeded from.
 *
 * A fresh Snapchat account is shown no Quick Add suggestions at all, so there is
 * no roster to walk and nothing in the ledger to offer it. It is onboarded by
 * SEARCHING people by name -- proven on the device on 2026-08-19 -- and that
 * needs a list of names, which is what an operator pastes in here. About fifty
 * is enough: once an account has that many friends Snapchat starts suggesting
 * people of its own, and the ordinary roster walk takes over.
 *
 * The handles are stored as their own thing rather than as ledger rows. Every
 * Person carries what the vision model read -- display name, what the avatar
 * presents as, nationality, a confidence -- and the filter drops a row whose
 * signals are missing, so an imported handle entering that table would be
 * swallowed on arrival. A person here becomes a Person only when an account is
 * actually handed them.
 *
 * The export on the Followed screen writes exactly this format -- one handle per
 * line, nothing else -- so a list acquired by one system imports into the next
 * without anyone editing a file in between.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A handle Snapchat could actually have. Deliberately the same shape the
 * extractor's own validator accepts: 3-15 of letters, digits, dot, dash,
 * underscore. Anything else in the file is a heading, a URL somebody pasted, or
 * a stray comma, and is reported back rather than stored -- an invented handle
 * costs a search and a miss on every account that is ever handed it.
 */
const HANDLE = /^[a-z0-9._-]{3,15}$/;

/** One paste. 200KB is about 12,000 handles; the cap is on the body, not the count. */
export class ImportHandlesDto {
  @IsString()
  @MaxLength(200_000)
  text!: string;
}

export class ClearImportedDto {
  @IsOptional()
  @IsString()
  which?: 'used' | 'all';
}

@Controller('api/onboarding')
@UseGuards(ApiKeyGuard)
export class OnboardingController {
  constructor(private readonly prisma: PrismaService) {}

  /** What is in the pool, and how much of it is still spendable. */
  @Get()
  async list(@Req() req: any, @Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const clientId = req.client.id;
    const [total, used, items] = await Promise.all([
      this.prisma.onboardingHandle.count({ where: { clientId } }),
      this.prisma.onboardingHandle.count({ where: { clientId, usedAt: { not: null } } }),
      this.prisma.onboardingHandle.findMany({
        where: { clientId },
        orderBy: [{ usedAt: 'asc' }, { createdAt: 'desc' }],
        take,
        select: {
          id: true,
          handle: true,
          usedAt: true,
          createdAt: true,
          account: { select: { label: true } },
        },
      }),
    ]);
    return {
      total,
      used,
      available: total - used,
      items: items.map((i) => ({
        id: i.id,
        handle: i.handle,
        usedAt: i.usedAt,
        createdAt: i.createdAt,
        account: i.account?.label ?? null,
      })),
    };
  }

  /**
   * Paste a file in. -> what happened to every line of it.
   *
   * Four counts rather than one, because "added 12" out of a 50-line file is a
   * question and not an answer. `duplicate` is the normal way to top a list up:
   * re-importing the same file must not double it, which is what the unique
   * index on (client, handle) enforces.
   */
  @Post()
  async importHandles(@Body() dto: ImportHandlesDto, @Req() req: any) {
    const clientId = req.client.id;
    const seen = new Set<string>();
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const raw of dto.text.split(/[\r\n,;]+/)) {
      const handle = raw.trim().replace(/^@/, '').toLowerCase();
      if (!handle) continue;
      if (!HANDLE.test(handle)) {
        // Capped: a pasted HTML page would otherwise answer with a megabyte of
        // its own markup, one "invalid" at a time.
        if (invalid.length < 50) invalid.push(raw.trim().slice(0, 40));
        continue;
      }
      if (seen.has(handle)) continue;
      seen.add(handle);
      valid.push(handle);
    }

    const { count } = await this.prisma.onboardingHandle.createMany({
      data: valid.map((handle) => ({ clientId, handle })),
      skipDuplicates: true,
    });

    return {
      added: count,
      duplicate: valid.length - count,
      invalid,
      total: await this.prisma.onboardingHandle.count({ where: { clientId } }),
    };
  }

  /**
   * Empty the pool, or just the part of it that has been spent.
   *
   * `used` is the housekeeping one and the default: those rows exist to stop a
   * handle being handed to a second account, so clearing them is deliberate and
   * has a consequence worth stating -- the same people become eligible again.
   */
  @Delete()
  async clear(@Body() dto: ClearImportedDto, @Req() req: any) {
    const clientId = req.client.id;
    const where =
      dto?.which === 'all' ? { clientId } : { clientId, usedAt: { not: null } };
    const { count } = await this.prisma.onboardingHandle.deleteMany({ where });
    return { deleted: count };
  }
}
