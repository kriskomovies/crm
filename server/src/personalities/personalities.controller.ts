/**
 * Personality CRUD for the operator UI.
 *
 * Everything under /api/personalities lives here and nowhere else. The CRM
 * controller deliberately owns no personality-scoped route: NestJS resolves
 * duplicate paths silently by registration order, so a second controller
 * claiming e.g. GET /api/personalities/:id/targets would shadow this one with
 * no warning at boot and no error at runtime.
 *
 * Guarded by the same per-client API key as /v1. Without it a personality id
 * was enough to read another tenant's ledger, extend it, retune its caps, or
 * DELETE it and cascade away every handle it had ever claimed.
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { PersonalitiesService } from './personalities.service';


/**
 * A filename Content-Disposition can carry safely.
 *
 * The personality name is operator-typed free text up to 80 characters. A quote
 * or a newline in it would terminate the header value early, and everything
 * after it becomes attacker-chosen response headers -- so the name is reduced
 * to the characters a filename needs rather than escaped.
 */
function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ledger';
}

/**
 * Write, and wait if the socket is full.
 *
 * `res.write` returning false means the kernel buffer is full and Node is now
 * queueing the rest in process memory. Ignoring it on a 50,000-row export
 * rebuilds in the Node heap exactly the whole-ledger-in-memory cost the
 * streaming export exists to avoid, just one layer further down.
 *
 * 'close' is waited on alongside 'drain' because the other outcome of a full
 * buffer is that the operator cancelled the download. Drain never fires on a
 * dead socket, so a 'drain'-only wait leaves this promise pending forever, and
 * with it the generator holding an open cursor over the ledger -- one abandoned
 * click each.
 */
function write(res: any, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    if (res.write(chunk)) return resolve();
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

class CreatePersonalityDto {
  @IsString()
  @MaxLength(80)
  name!: string;
}

class CreateAccountDto {
  @IsString()
  @MaxLength(80)
  label!: string;
}

class AttachTargetsDto {
  @IsArray()
  @ArrayNotEmpty()
  // A bounded batch: the whole list is written row by row so the unique
  // constraint can reject individual handles without failing the request.
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  // Per element as well as per array. A real handle is 15 characters; without
  // this, a thousand megabyte strings are normalised, rejected one by one, and
  // then echoed back in `invalid`.
  @MaxLength(200, { each: true })
  handles!: string[];

  @IsOptional()
  @IsIn(['manual', 'extraction'])
  source?: 'manual' | 'extraction';
}

/**
 * Pause and resume only. The cap moved to PUT /api/settings, where it is one
 * number for the whole client -- see Client.dailyCapPerAccount.
 */
class UpdateAccountDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@Controller('api/personalities')
@UseGuards(ApiKeyGuard)
export class PersonalitiesController {
  constructor(private readonly personalities: PersonalitiesService) {}

  /**
   * Not paginated, on purpose -- see PersonalitiesService.list. The result is
   * bounded by how many personalities one client runs, and the UI needs all of
   * them to fill the filter dropdown the stats screen depends on.
   *
   * It still answers in the {items, nextCursor} envelope every list endpoint
   * uses, with a cursor that is always null. "Do not paginate this" and "do not
   * use the shared shape" are different decisions: a client that special-cases
   * one endpoint's response is a client that breaks the day it is paginated,
   * and a permanently null cursor already says "there is no next page".
   */
  @Get()
  async list(@Req() req: any) {
    return { items: await this.personalities.list(req.client.id), nextCursor: null };
  }

  @Post()
  create(@Body() dto: CreatePersonalityDto, @Req() req: any) {
    return this.personalities.create(req.client.id, dto.name);
  }

  @Post(':id/accounts')
  addAccount(@Param('id') id: string, @Body() dto: CreateAccountDto, @Req() req: any) {
    return this.personalities.addAccount(req.client.id, id, dto.label);
  }

  @Get(':id/targets')
  targets(
    @Param('id') id: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Req() req: any,
    @Query('q') q?: string,
    @Query('state') state?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.personalities.targets(req.client.id, id, limit, q, state, cursor);
  }

  /**
   * The same rows as GET :id/targets, as a file.
   *
   * A distinct path rather than `?format=csv` on the route above. Changing an
   * existing route's content type by query parameter corrupts the OpenAPI
   * document the web client generates from -- one operation, two mutually
   * exclusive response bodies -- and leaves every existing caller one typo away
   * from a CSV it will try to JSON.parse.
   *
   * @Res without passthrough, as PersonalityLedgerController.register does: the
   * body is not JSON, and there are no global interceptors (main.ts installs
   * only the ValidationPipe and CORS) that would otherwise want to wrap it.
   *
   * No token in the URL and no fetch on the client side: ApiKeyGuard falls back
   * to the operator's session cookie, so this is reachable by a plain
   * <a href download>, which is also what keeps the browser from ever holding
   * the file in memory.
   */
  /**
   * The followed list as a plain text file: one handle per line, nothing else.
   *
   * It was a CSV of eight columns, which is the right shape for a spreadsheet
   * and the wrong one for what this export is actually for -- feeding handles
   * back into a machine. A new account has no Quick Add suggestions and is
   * onboarded by searching people by name, so the list it is fed has to be a
   * list of names. An export that comes out in the format the import takes
   * closes that loop without anybody editing a file in between.
   *
   * The route keeps its .csv sibling's shape (same ownership check, same
   * streaming, same cursor) and only the body changes: no header row, no
   * quoting, no BOM -- a BOM would arrive as an invisible character on the front
   * of the first handle and that handle would never match anybody.
   */
  @Get(':id/targets.txt')
  async targetsTxt(
    @Param('id') id: string,
    @Req() req: any,
    @Res() res: any,
    @Query('q') q?: string,
    @Query('state') state?: string,
    // Comma-separated: `high`, or `high,medium`. Absent or complete means every
    // confidence, so the plain URL still exports the whole list.
    @Query('conf') conf?: string,
  ) {
    // Ownership and the state value are settled before a byte is written. Once
    // headers are out, a 404 can only present as a truncated download.
    const { name, rows } = await this.personalities.exportTargets(
      req.client.id, id, q, state, conf);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      // The confidence goes in the filename because these files are the unit of
      // exchange between two systems -- a folder of them called
      // "kris-followed.txt" three times over is unusable.
      `attachment; filename="${safeName(name)}-${state || 'all'}${conf ? `-${safeName(conf)}` : ''}.txt"`,
    );
    for await (const batch of rows) {
      // The operator closed the tab. Returning ends the for-await, which closes
      // the generator and its cursor, rather than paging the rest of the ledger
      // out of Postgres into a socket nobody is reading.
      if (res.destroyed) return;
      let chunk = '';
      for (const r of batch) {
        // A row with no handle cannot exist -- it is the ledger's natural key --
        // but an empty line in a file of handles would import as one, so it is
        // skipped rather than trusted.
        if (r.handle) chunk += `${r.handle}
`;
      }
      await write(res, chunk);
    }
    res.end();
  }

  @Post(':id/targets')
  attach(@Param('id') id: string, @Body() dto: AttachTargetsDto, @Req() req: any) {
    return this.personalities.attach(req.client.id, id, dto.handles, dto.source ?? 'manual');
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: any) {
    await this.personalities.remove(req.client.id, id);
  }
}

/**
 * Account edits sit on their own path because an account id is already unique;
 * routing them under /api/personalities/:id/accounts/:accountId would invite a
 * caller to pass a mismatched pair and expect it to mean something.
 */
@Controller('api/accounts')
@UseGuards(ApiKeyGuard)
export class AccountsController {
  constructor(private readonly personalities: PersonalitiesService) {}

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAccountDto, @Req() req: any) {
    return this.personalities.updateAccount(req.client.id, id, dto);
  }

  /**
   * Hand this account today's cap back, so the operator can run the same test
   * again without waiting for midnight.
   *
   * POST rather than a field on the PATCH above. UpdateAccountDto is a
   * whitelist of things an account IS; this is a thing that HAPPENS to it, and
   * folding it in would mean a settable `reset: true` that is always false when
   * read back. No body at all: forbidNonWhitelisted is global, so an empty
   * object is the correct request and anything else is a 400.
   *
   * 200 rather than Nest's default 201 for POST, because nothing was created
   * and the reply is a report of what changed.
   */
  @Post(':id/reset-daily-cap')
  @HttpCode(200)
  resetDailyCap(@Param('id') id: string, @Req() req: any) {
    return this.personalities.resetDailyCap(req.client.id, id);
  }

  /**
   * Delete the account and everything hanging off it.
   *
   * 200 with a report rather than 204, unlike the personality delete beside it.
   * This cascades through assignments, hides and sheets, and an operator who has
   * just done something irreversible is owed the size of it -- how many follows
   * and sheets went with it -- rather than an empty body.
   */
  @Delete(':id')
  @HttpCode(200)
  removeAccount(@Param('id') id: string, @Req() req: any) {
    return this.personalities.removeAccount(req.client.id, id);
  }
}
