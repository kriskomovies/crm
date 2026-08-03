/**
 * How hard to push an account, as one setting per client.
 *
 * Two numbers that are really one decision, which is why they live together
 * rather than in two screens:
 *
 *   dailyCapPerAccount  how many targets the server hands EACH account per day
 *   followPaceSeconds   how long a machine waits between follows
 *
 * The first is enforced here -- TargetsService.claim meters against it, and a
 * client that never asks is still capped. The second is only SERVED: this
 * server hands out handles and follows nothing, so the agent has to honour it,
 * and a machine running an older build keeps using its own config file. That
 * asymmetry is worth knowing before trusting the number on the screen.
 *
 * Both used to be per-account or per-config-file. The cap protects against
 * Snapchat rate-limiting the account, and that threshold is a property of
 * Snapchat and of how old an account is -- not of which account it is -- so
 * twenty copies of the number meant twenty places to change it.
 */
import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The ceilings are deliberately generous and the floors deliberately zero.
 *
 * A cap of 0 pauses every account at once without touching any of them, which
 * is the fastest brake available when something is going wrong. A pace of 0
 * means no wait, and is a real answer for a dry run against a throwaway
 * account. Neither is advisable and both have to be reachable.
 */
class SettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  dailyCapPerAccount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  followPaceSeconds?: number;
}

@Controller('api/settings')
@UseGuards(ApiKeyGuard)
export class SettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async read(@Req() req: any) {
    const client = await this.prisma.client.findUniqueOrThrow({
      where: { id: req.client.id },
      select: { dailyCapPerAccount: true, followPaceSeconds: true },
    });
    return client;
  }

  /**
   * PUT rather than PATCH, but both fields are optional: the screen sends the
   * whole object, and a caller changing one number should not have to restate
   * the other and risk stamping a stale value over someone else's edit.
   */
  @Put()
  async save(@Body() dto: SettingsDto, @Req() req: any) {
    const client = await this.prisma.client.update({
      where: { id: req.client.id },
      data: {
        ...(dto.dailyCapPerAccount === undefined
          ? {}
          : { dailyCapPerAccount: dto.dailyCapPerAccount }),
        ...(dto.followPaceSeconds === undefined
          ? {}
          : { followPaceSeconds: dto.followPaceSeconds }),
      },
      select: { dailyCapPerAccount: true, followPaceSeconds: true },
    });
    // Takes effect on the next claim -- there is no cached copy anywhere, and
    // the cap is read inside the claim transaction rather than at boot.
    return { saved: true, ...client };
  }
}
