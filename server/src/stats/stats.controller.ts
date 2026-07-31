/**
 * The dashboard's single read.
 *
 * One endpoint rather than one per panel: every block is cut from the same
 * window, and eight requests that each re-resolve the range can disagree with
 * each other when a sheet lands between them.
 */
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { StatsService } from './stats.service';

@Controller('api/stats')
@UseGuards(ApiKeyGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  get(
    @Req() req: any,
    @Query('personalityId') personalityId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.stats.stats(req.client.id, { personalityId, from, to });
  }
}
