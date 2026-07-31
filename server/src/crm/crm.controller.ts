/**
 * Read endpoints for the CRM.
 *
 * Separate from the machine-facing API on purpose: the emulator clients get
 * narrow, per-account endpoints guarded by an API key, while the operator UI
 * needs to see across a whole client's personalities at once. Mixing the two
 * would mean the key an emulator carries could also read the entire book of
 * business.
 *
 * "A whole client's" -- singular. These routes carried no guard at all, so one
 * unauthenticated GET returned every tenant's personalities, caps and spend,
 * and GET sheets/:id/image minted a presigned URL for any tenant's uploaded
 * screenshot from the id alone. They take the same key as /v1 now, and every
 * query is scoped to the client that key belongs to.
 *
 * Personality-scoped routes belong to PersonalitiesController, not here. Two
 * controllers claiming one path is resolved silently by registration order, so
 * the split is by prefix and kept absolute.
 */
import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { pageSize, slicePage } from '../common/pagination';
import { PersonalitiesService } from '../personalities/personalities.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@Controller('api')
@UseGuards(ApiKeyGuard)
export class CrmController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly personalities: PersonalitiesService,
    private readonly storage: StorageService,
  ) {}

  /** Everything the dashboard needs in one call: personalities, accounts, cap usage. */
  @Get('overview')
  async overview(@Req() req: any) {
    const clientId = req.client.id;
    const [personalities, spend, states] = await Promise.all([
      // Delegated rather than rebuilt. This route had grown its own version of
      // the same rollup that asked for each account's queued count, review
      // count and today's handouts one account at a time: three round trips per
      // account, 30,000 at a hundred clients, and the dashboard never loads.
      this.personalities.list(clientId),
      this.prisma.extraction.aggregate({
        _sum: { usd: true, promptTokens: true, completionTokens: true },
        _count: true,
        where: { sheet: { account: { personality: { clientId } } } },
      }),
      this.prisma.assignment.groupBy({
        by: ['state'],
        where: { account: { personality: { clientId } } },
        _count: true,
      }),
    ]);

    return {
      personalities,
      totals: {
        sheets: spend._count,
        // Prisma hands a Decimal back and JSON.stringify turns that into a
        // string, which every arithmetic consumer then reads as NaN.
        usd: Number(spend._sum.usd ?? 0),
        promptTokens: spend._sum.promptTokens ?? 0,
        completionTokens: spend._sum.completionTokens ?? 0,
        byState: Object.fromEntries(states.map((s) => [s.state, s._count])),
      },
    };
  }

  @Get('sheets')
  async sheets(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Req() req: any,
    @Query('cursor') cursor?: string,
  ) {
    const take = pageSize(limit);
    const rows = await this.prisma.sheet.findMany({
      where: { account: { personality: { clientId: req.client.id } } },
      // receivedAt is not unique -- two sheets can share a millisecond -- so id
      // breaks the tie. Without a total order a cursor page silently repeats or
      // skips the rows either side of the boundary.
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        status: true,
        error: true,
        receivedAt: true,
        // Selected field by field rather than `include: { extraction: true }`,
        // which also drags rawReply -- the verbatim VLM answer, tens of KB a
        // row -- across the wire for a list that never looks at it.
        extraction: {
          select: {
            profilesFound: true,
            seconds: true,
            usd: true,
            model: true,
            distinctCuesRatio: true,
          },
        },
        account: { select: { label: true, personality: { select: { name: true } } } },
        _count: { select: { people: true } },
      },
    });

    const { items, nextCursor } = slicePage(rows, take);
    return {
      items: items.map((s) => ({
        id: s.id,
        account: s.account.label,
        personality: s.account.personality.name,
        status: s.status,
        error: s.error,
        receivedAt: s.receivedAt,
        profilesFound: s.extraction?.profilesFound ?? 0,
        newPeople: s._count.people,
        seconds: s.extraction?.seconds ?? 0,
        usd: Number(s.extraction?.usd ?? 0),
        model: s.extraction?.model ?? null,
        distinctCuesRatio: s.extraction?.distinctCuesRatio ?? null,
      })),
      nextCursor,
    };
  }

  @Get('sheets/:id/image')
  async image(@Param('id') id: string, @Req() req: any) {
    // findFirst with the ownership predicate, not findUnique on the id: a sheet
    // id is enough to name another tenant's screenshot, and the answer here is
    // a URL that serves it.
    const sheet = await this.prisma.sheet.findFirst({
      where: { id, account: { personality: { clientId: req.client.id } } },
      select: { storageKey: true },
    });
    if (!sheet) throw new NotFoundException();
    return { url: await this.storage.presign(sheet.storageKey) };
  }
}
