/**
 * "Who should this account follow next", and the result callback.
 *
 * GET is not a read: it CLAIMS targets and counts them against today's cap and
 * against this account's rolling session window. An account that polls and then
 * crashes has spent that budget, which is the conservative direction -- the
 * alternative risks the same person being handed to two processes and followed
 * twice.
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
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { pageSize, slicePage } from '../common/pagination';
import { PersonalitiesService } from '../personalities/personalities.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { RosterService } from './roster.service';
import { PrismaService } from '../prisma/prisma.service';
import { FollowResult, TargetsService } from './targets.service';

/** The handles a machine can see on its own Quick Add, right now. */
/**
 * How many people to seed at once when an account has no roster of its own.
 *
 * The claim path sizes this from the batch the agent asked for; the roster path
 * has no such number -- the agent asks about a whole sheet, not for N targets --
 * so it needs one of its own. Twenty-five is the shipped claim_limit, which is
 * what an agent has always been handed in one go.
 */
const SEED_BATCH = 25;

/** The query-string spellings of "off" for `onboarding`. */
const OFF = new Set(['0', 'false', 'no', 'off']);

/**
 * May this claim fall back to the onboarding pool? -> true unless told not to.
 *
 * A closed set of "off" spellings, and EVERYTHING ELSE IS ON, including a value
 * nobody recognises. The asymmetry is deliberate and runs the safe way: seeding
 * is what every machine did before the flag existed, so an unreadable value has
 * to land on the old behaviour rather than silently disable the one path that
 * gets a brand-new account moving at all.
 *
 * Not a ParseBoolPipe for the same reason. This rides on the one GET every
 * agent in the fleet makes, and a pipe answers a malformed value with a 400 --
 * turning a typo in one machine's config into an account that claims nothing
 * whatsoever, which is a far worse failure than seeding when it need not have.
 *
 * Exported so it can be tested without a database: everything else on this path
 * needs a booted app and a real Postgres, and the parsing is the part with the
 * edge cases in it.
 */
export function mayOnboard(param: string | undefined): boolean {
  return !OFF.has((param ?? '').trim().toLowerCase());
}

class RosterDto {
  @IsOptional()
  @IsArray()
  // A roster is about a hundred. The bound is on the request rather than only in
  // the service so an absurd body is refused before it reaches a transaction
  // holding a row lock.
  @ArrayMaxSize(400)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  handles?: string[];

  /**
   * The sheet just extracted, instead of the handles off it.
   *
   * The agent uploads a screenshot and this server reads every handle on it --
   * with a vision model, against the full-size image, which is a better read
   * than the agent can get from 9px text through Tesseract. Making the agent
   * OCR the same rows again, only worse, to name people this server already
   * named is work for nothing and a second place for the two to disagree.
   *
   * So: send the job id and the handles are taken from that sheet's own reply.
   * `handles` still works and still wins when both are sent -- the screen is not
   * always the sheet, and a caller that means a specific list must be able to
   * say so.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  jobId?: string;

  /**
   * May this call fall back to the onboarding pool when the sheet has nothing
   * to add? Absent means yes, which is what every machine did before the flag
   * existed and what a client too old to send it still gets.
   *
   * The agent owns this decision, not the server. Whether an account needs
   * seeding is a fact about the DEVICE -- a fresh install versus one that has
   * been running a month -- and the agent is the side that can see it. From
   * here a new account and an established one whose roster is merely empty
   * today look identical.
   */
  @IsOptional()
  @IsBoolean()
  onboarding?: boolean;
}

class ReportDto {
  @IsIn(['followed', 'failed', 'skipped'])
  result!: FollowResult;

  /**
   * Did the agent SEE this fail, or does it merely not know?
   *
   * `failed` covers both today and they are not the same event. The pill
   * provably back grey is evidence the add did not happen; a button that could
   * not be read at all is evidence of nothing, and the add may well have landed
   * on the phone. The agent has always known which it had -- it writes
   * UNVERIFIED_NOTE for the second -- and has had no field to say it in.
   *
   * It decides whether the cap slot comes back. Absent, the slot is kept, which
   * is the safe reading and what every existing client gets.
   */
  @IsOptional()
  @IsBoolean()
  verified?: boolean;

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
    private readonly onboarding: OnboardingService,
    private readonly rosters: RosterService,
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
    /**
     * `onboarding=0` turns the seeding fallback below off for this call.
     *
     * A raw string rather than a ParseBoolPipe: this is a query parameter on
     * the one GET that every agent in the fleet makes, and a pipe would answer
     * a malformed value with a 400 -- turning a typo in one machine's config
     * into an account that claims nothing at all. Anything that is not an
     * explicit off is on, which is also what a client too old to send it gets.
     */
    @Query('onboarding') onboardingParam: string | undefined,
    @Req() req: any,
  ) {
    await this.assertOwned(accountId, req.client.id);
    const want = Math.min(limit, 100);
    const seedingAllowed = mayOnboard(onboardingParam);
    let claimed = await this.targets.claim(accountId, want);

    // A NEW ACCOUNT ASKS AND IS HANDED NOTHING, FOREVER
    //
    // Snapchat shows a fresh account no Quick Add suggestions, so there is no
    // roster to photograph, nothing to extract, and therefore nothing queued for
    // it -- and the claim above comes back empty every cycle. Seeding is tried
    // only in exactly that state: an empty claim from an account that has not
    // yet made its fifty searched adds. An established account always has a
    // queue, so it never reaches this line.
    //
    // The re-claim is a real claim, so both caps meter these adds like any
    // other. They ARE ordinary adds; the only difference is that the machine
    // reaches them by searching a name instead of finding a row.
    //
    // `seedingAllowed` is the agent's own switch, and it is checked FIRST so a
    // machine with seeding turned off costs nothing to ask -- not even the
    // isOnboarding lookup.
    let onboarding = false;
    if (
      seedingAllowed &&
      claimed.targets.length === 0 &&
      (await this.onboarding.isOnboarding(accountId))
    ) {
      const seeded = await this.onboarding.seed(accountId, want);
      if (seeded > 0) {
        claimed = await this.targets.claim(accountId, want);
        onboarding = claimed.targets.length > 0;
      }
    }

    return {
      targets: claimed.targets,
      // How the machine is meant to reach these people. `search` says this
      // account has no roster and each handle must be found by name in
      // Snapchat's own search; anything else means the ordinary walk. Sent as a
      // word rather than a boolean because there will be a third way before
      // there is a second product.
      via: onboarding ? 'search' : 'roster',
      // Told explicitly so the client can back off instead of hot-polling an
      // exhausted cap.
      remainingToday: await this.targets.remainingToday(accountId),
      // The session cap's version of the same number, and the reason it exists
      // is narrower than "symmetry". A short batch used to have exactly one
      // explanation once remainingToday was healthy -- the queue ran dry -- and
      // an agent in the field relies on that to decide it may run an
      // irreversible pass hiding people from its Quick Add roster. The session
      // cap gives a short batch a second explanation, so the two budgets are
      // both stated and a client can require room in BOTH before believing the
      // queue is what ran out.
      //
      // Comes out of the claim rather than from a follow-up query: see
      // ClaimResult. It is the one number here that cannot be re-derived
      // afterwards without being wrong in the dangerous direction.
      remainingInWindow: claimed.remainingInWindow,
      // How long the window is, so a client that finds it full can sleep for a
      // share of it instead of hot-polling a metered write until it rolls.
      sessionWindowMinutes: claimed.sessionWindowMinutes,
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

  /**
   * The whole roster, answered row by row.
   *
   * POST rather than GET because a hundred handles do not belong in a query
   * string, and because this WRITES: an `add` is charged to today's cap in the
   * same transaction that decided it, exactly as a claim is.
   *
   * It replaces the two questions this endpoint used to answer separately -- N
   * newest targets, 500 newest refusals -- neither of which was about the screen
   * in front of the machine. Every handle sent comes back with one of add,
   * reject or leave, and the machine needs no rule of its own beyond doing what
   * it is told.
   */
  @Post('roster')
  async roster(
    @Param('accountId') accountId: string,
    @Body() dto: RosterDto,
    @Req() req: any,
  ) {
    await this.assertOwned(accountId, req.client.id);
    // The handles win when both are sent: the screen is not always the sheet.
    const handles = dto.handles?.length
      ? dto.handles
      : await this.rosters.handlesOnSheet(accountId, dto.jobId);
    const answer = await this.rosters.decide(accountId, handles);

    // SEEDING, THE SAME AS THE CLAIM DOES IT.
    //
    // claim() falls back to the onboarding pool when it comes back empty from
    // an account that has not finished being seeded, and answers `via: search`
    // so the agent looks each handle up by name instead of hunting a roster.
    // This endpoint replaced the claim in the cycle and did not carry that with
    // it, which left a hole the claim never had: an account whose Quick Add is
    // full of people a SIBLING already holds produces a sheet, so the cycle asks
    // here rather than there -- and every row comes back reject, no add, and no
    // seeding, forever. That is exactly the state unamnxz reached: one workable
    // person in a ledger of five thousand.
    //
    // An empty claim was the old trigger; no ADD verdict is the same fact
    // measured on the roster. Rejections do not count, because hiding people is
    // not work this account can grow on.
    // `onboarding: false` in the body is the agent's own switch, the same one
    // the claim takes as a query parameter. Absent means yes, so a client too
    // old to send it behaves exactly as it always has.
    const nothingToAdd = !answer.verdicts.some((v) => v.do === 'add');
    let via = 'roster';
    if (dto.onboarding !== false && nothingToAdd
        && (await this.onboarding.isOnboarding(accountId))) {
      const seeded = await this.onboarding.seed(accountId, SEED_BATCH);
      if (seeded > 0) {
        // A real claim, so both caps meter these adds like any other.
        const claimed = await this.targets.claim(accountId, SEED_BATCH);
        if (claimed.targets.length > 0) {
          return {
            verdicts: claimed.targets.map((t: { handle: string }) => ({
              handle: t.handle,
              do: 'add',
              why: 'seeded by search -- this account has no roster of its own yet',
            })),
            // ClaimResult carries only the window; the daily figure is its own
            // query, exactly as the claim endpoint above does it.
            remainingToday: await this.targets.remainingToday(accountId),
            remainingInWindow: claimed.remainingInWindow,
            sessionWindowMinutes: claimed.sessionWindowMinutes,
            via: 'search',
            paceSeconds: await this.targets.paceSeconds(accountId),
          };
        }
      }
    }

    return {
      ...answer,
      // `roster`, so the agent walks. The seeded reply above says `search`, and
      // the agent has answered both since long before this endpoint existed.
      via,
      // Delivered where it is about to be used, like the claim's copy: every
      // cycle asks this before it taps anything, so the machine cannot act on a
      // pace older than the roster in front of it.
      paceSeconds: await this.targets.paceSeconds(accountId),
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
    await this.targets.report(accountId, handle, dto.result, dto.note, dto.verified);
    return { ok: true };
  }

  /**
   * "I have swiped this refused person off my roster."
   *
   * Sits beside :handle/result rather than inside it because the two report on
   * different populations: a result belongs to a target this account was handed,
   * a hide belongs to somebody it was told it would never be handed. Same guard,
   * same ownership check, same shape of reply.
   *
   * No body. There is one thing an agent can say here and the route says it.
   */
  @Post(':handle/hidden')
  async hidden(
    @Param('accountId') accountId: string,
    @Param('handle') handle: string,
    @Req() req: any,
  ) {
    await this.assertOwned(accountId, req.client.id);
    await this.targets.hide(accountId, handle);
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
