/**
 * How hard to push an account, as one setting per client.
 *
 * Four numbers that are really one decision, which is why they live together
 * rather than in four screens:
 *
 *   dailyCapPerAccount    how many targets the server hands EACH account per day
 *   sessionCapPerAccount  and how many in any rolling window
 *   sessionWindowMinutes  how long that window is
 *   onboardingDailyCap    the first of those two again, for an account still
 *   onboardingSessionCap  being onboarded -- they REPLACE the pair above while
 *                         it is, because searching exact usernames on a
 *                         brand-new account is different work at a different
 *                         risk, and one number could not answer both
 *   followPaceSeconds     how long a machine waits between follows
 *
 * The first three are enforced here -- TargetsService.claim meters against both
 * caps inside one transaction, and a client that never asks is still capped.
 * The last is only SERVED: this server hands out handles and follows nothing,
 * so the agent has to honour it, and a machine running an older build keeps
 * using its own config file. That asymmetry is worth knowing before trusting
 * the number on the screen, and it is why the two caps sit above the pace here
 * and on the screen.
 *
 * The session cap is a window rather than a session because the server cannot
 * see a session: it has no idea when a machine starts or stops working an
 * account. It exists because a young Snapchat account stops accepting adds at
 * roughly 40 a day, so one account handed 240 back to back spends the tail of
 * the day against a cooldown. Setting the window to 1440 makes it a second
 * daily cap; 60 gives the rotation it was asked for -- 40 on A, then B, then C,
 * then back to A. See Client.sessionCapPerAccount.
 *
 * Both used to be per-account or per-config-file. The cap protects against
 * Snapchat rate-limiting the account, and that threshold is a property of
 * Snapchat and of how old an account is -- not of which account it is -- so
 * twenty copies of the number meant twenty places to change it.
 *
 * A fifth field sits here that is not about pace at all:
 *
 *   extractionModel       which VLM reads the contact sheets
 *
 * It is here rather than on a screen of its own because it is the same shape of
 * decision -- one value, per client, that the operator changes and the server
 * obeys from the next job -- and because Client already carried the column,
 * read-only, with no way to set it short of psql. It is the one setting on this
 * screen with an accuracy cost attached to the money it saves; the numbers are
 * in vlm_eval/FORMAT-AB.md and the screen prints them next to the field.
 */
import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { EXTRACTION_MODELS } from '../extraction/models';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The ceilings are deliberately generous and the floors deliberately zero.
 *
 * A cap of 0 pauses every account at once without touching any of them, which
 * is the fastest brake available when something is going wrong. A pace of 0
 * means no wait, and is a real answer for a dry run against a throwaway
 * account. Neither is advisable and both have to be reachable.
 *
 * sessionWindowMinutes is the one exception, and its floor is 1. A window of 0
 * minutes counts nothing, so the cap beside it could never bind: the pair would
 * read as a configured limit while being silently off, which is the one failure
 * mode a brake must not have. 1440 is a day, the setting that turns the session
 * cap into a second daily cap.
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
  @Max(2000)
  sessionCapPerAccount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  sessionWindowMinutes?: number;

  /**
   * The same two ceilings for an account that is still ONBOARDING -- one short
   * of ONBOARD_TARGET searched adds. Same floors and ceilings as the pair above,
   * for the same reasons: 0 pauses every new account at once without touching an
   * established one, which is a brake worth having separately.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  onboardingDailyCap?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  onboardingSessionCap?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  followPaceSeconds?: number;

  /**
   * Which VLM reads the contact sheets.
   *
   * @IsIn against a closed set, not @IsString. The value is handed to the
   * gateway as the model name, so an unrecognised string is accepted here and
   * then fails every extraction this client uploads -- see extraction/models.ts
   * for why the list is closed and why it is not derived from the price table.
   */
  @IsOptional()
  @IsIn(EXTRACTION_MODELS as readonly string[])
  extractionModel?: string;
}

/**
 * Named once rather than written out at all three sites. A field that reached
 * the DTO but not one of the selects would be saved and never read back, which
 * looks exactly like a save that did not happen.
 */
const SETTINGS_SELECT = {
  dailyCapPerAccount: true,
  sessionCapPerAccount: true,
  sessionWindowMinutes: true,
  onboardingDailyCap: true,
  onboardingSessionCap: true,
  followPaceSeconds: true,
  extractionModel: true,
} as const;

/**
 * The vocabulary travels with the value, exactly as the rules screen serves its
 * origin list rather than letting the UI carry one: a hardcoded dropdown drifts
 * out of step with what @IsIn accepts, and the symptom is a 400 on an option the
 * screen itself offered.
 *
 * Served on the read AND on the save reply, because a screen that adopts the
 * save reply as its new state would otherwise lose the list on first save.
 *
 * It is not a settable field and must never become one: SettingsDto does not
 * declare it, and forbidNonWhitelisted means a caller that spreads a reply
 * straight back into a PUT body gets a 400 naming `models`. That is the correct
 * failure -- the list is the server's, not the client's -- but it is worth
 * knowing before someone writes `save({ ...settings })`.
 */
const MODELS = [...EXTRACTION_MODELS];

@Controller('api/settings')
@UseGuards(ApiKeyGuard)
export class SettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async read(@Req() req: any) {
    const client = await this.prisma.client.findUniqueOrThrow({
      where: { id: req.client.id },
      select: SETTINGS_SELECT,
    });
    return { ...client, models: MODELS };
  }

  /**
   * PUT rather than PATCH, but every field is optional: the screen sends the
   * whole object, and a caller changing one number should not have to restate
   * the others and risk stamping a stale value over someone else's edit.
   */
  @Put()
  async save(@Body() dto: SettingsDto, @Req() req: any) {
    const client = await this.prisma.client.update({
      where: { id: req.client.id },
      data: {
        ...(dto.dailyCapPerAccount === undefined
          ? {}
          : { dailyCapPerAccount: dto.dailyCapPerAccount }),
        ...(dto.sessionCapPerAccount === undefined
          ? {}
          : { sessionCapPerAccount: dto.sessionCapPerAccount }),
        ...(dto.sessionWindowMinutes === undefined
          ? {}
          : { sessionWindowMinutes: dto.sessionWindowMinutes }),
        ...(dto.onboardingDailyCap === undefined
          ? {}
          : { onboardingDailyCap: dto.onboardingDailyCap }),
        ...(dto.onboardingSessionCap === undefined
          ? {}
          : { onboardingSessionCap: dto.onboardingSessionCap }),
        ...(dto.followPaceSeconds === undefined
          ? {}
          : { followPaceSeconds: dto.followPaceSeconds }),
        ...(dto.extractionModel === undefined
          ? {}
          : { extractionModel: dto.extractionModel }),
      },
      select: SETTINGS_SELECT,
    });
    // Takes effect on the next claim -- there is no cached copy anywhere, and
    // both caps are read inside the claim transaction rather than at boot. The
    // model likewise: PipelineService reads Client.extractionModel per sheet, so
    // a sheet already in the queue is extracted with whatever is saved when the
    // worker picks it up, not with what was set when it was uploaded.
    return { saved: true, ...client, models: MODELS };
  }
}
