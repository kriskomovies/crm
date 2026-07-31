/**
 * "Who should this account follow next", and the result callback.
 *
 * GET is not a read: it CLAIMS targets and counts them against today's cap. An
 * account that polls and then crashes has spent that budget, which is the
 * conservative direction -- the alternative risks the same person being handed
 * to two processes and followed twice.
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { pageSize, slicePage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { FollowResult, TargetsService } from './targets.service';

class ReportDto {
  @IsIn(['followed', 'failed', 'skipped'])
  result!: FollowResult;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

@Controller('v1/accounts/:accountId/targets')
@UseGuards(ApiKeyGuard)
export class TargetsController {
  constructor(
    private readonly targets: TargetsService,
    private readonly prisma: PrismaService,
  ) {}

  private async assertOwned(accountId: string, clientId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, personality: { clientId } },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('account not found');
  }

  @Get()
  async claim(
    @Param('accountId') accountId: string,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Req() req: any,
  ) {
    await this.assertOwned(accountId, req.client.id);
    const targets = await this.targets.claim(accountId, Math.min(limit, 100));
    return {
      targets,
      // Told explicitly so the client can back off instead of hot-polling an
      // exhausted cap.
      remainingToday: await this.targets.remainingToday(accountId),
    };
  }

  @Post(':handle/result')
  async report(
    @Param('accountId') accountId: string,
    @Param('handle') handle: string,
    @Body() dto: ReportDto,
    @Req() req: any,
  ) {
    await this.assertOwned(accountId, req.client.id);
    await this.targets.report(accountId, handle, dto.result, dto.note);
    return { ok: true };
  }
}

@Controller('v1/personalities/:personalityId')
@UseGuards(ApiKeyGuard)
export class PersonalityLedgerController {
  constructor(
    private readonly targets: TargetsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Everyone this personality has taken, and which of its accounts holds them.
   *
   * Legacy: nothing in this repo calls it, and /api/personalities/:id/targets
   * answers the same question for the operator UI. It paged with take/skip and
   * returned a COUNT of the whole personality on every call -- two costs that
   * both grow with the ledger -- so it is on the contract shape now, but it is
   * a deletion candidate rather than something to build on.
   */
  @Get('ledger')
  async ledger(
    @Param('personalityId') personalityId: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Req() req: any,
    @Query('cursor') cursor?: string,
  ) {
    const personality = await this.prisma.personality.findFirst({
      where: { id: personalityId, clientId: req.client.id },
      select: { id: true },
    });
    if (!personality) throw new NotFoundException('personality not found');

    const take = pageSize(limit);
    // One row past the page: enough to know another page exists, without the
    // COUNT that used to run over every person this personality holds.
    return slicePage(await this.targets.ledger(personalityId, take + 1, cursor), take);
  }
}
