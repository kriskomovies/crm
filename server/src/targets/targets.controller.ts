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
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { pageSize, slicePage } from '../common/pagination';
import { PersonalitiesService } from '../personalities/personalities.service';
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

/**
 * What a machine read off its emulator's own profile screen.
 *
 * The length bounds are the only thing asserted here; the handle itself is
 * normalised and validated in the service, because a bad handle needs a message
 * quoting the value the machine actually sent, and because the shape rule lives
 * with normHandle rather than in two places.
 *
 * displayName and machine are declared even though nothing keys on them: the
 * global pipe runs with forbidNonWhitelisted, so an undeclared field the agent
 * already sends would be a 400 rather than something ignored.
 */
class RegisterAccountDto {
  @IsString()
  @MaxLength(200)
  handle!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  machine?: string;
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
      // The operator's pacing setting, delivered where it is about to be used.
      // Every cycle calls this before following, so the machine cannot act on a
      // number older than the batch in front of it -- which is the whole reason
      // this beats a value in a config file on twenty boxes.
      paceSeconds: await this.targets.paceSeconds(accountId),
      // Who the agent may hide from its Quick Add roster. Read AFTER the claim
      // above, and the ordering is load-bearing: the claim has just moved this
      // batch to handed_out under this account, which is what excludes it here.
      // Computed before it, the rows still queued would have looked like nobody
      // was going to add them and the agent would have hidden the very people it
      // was about to follow.
      refusedHandles: await this.targets.refusedHandles(accountId),
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
    private readonly personalities: PersonalitiesService,
  ) {}

  /**
   * A machine registering its own account under a personality it owns.
   *
   * Lives here rather than beside the operator's POST /api/personalities/:id/
   * accounts for two reasons. It is a /v1 machine route, authenticated by the
   * client key like every other call the agent makes. And this controller
   * already claims `v1/personalities/:personalityId`: a second controller
   * claiming the same prefix is resolved by NestJS silently, in registration
   * order, with no warning at boot -- see the header of personalities.controller.
   *
   * The status code is the answer to "did this create anything", so it is set
   * here rather than declared: 201 for a new account, 200 for one that already
   * existed. @Res without passthrough because Nest applies the route's default
   * 201 AFTER the handler returns, which would overwrite a status set on a
   * passthrough response.
   */
  @Post('accounts')
  async register(
    @Param('personalityId') personalityId: string,
    @Body() dto: RegisterAccountDto,
    @Req() req: any,
    @Res() res: any,
  ) {
    const out = await this.personalities.registerAccount(req.client.id, personalityId, dto);
    res.status(out.created ? 201 : 200).json(out);
  }

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
