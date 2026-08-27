/**
 * The operator-facing surface over the stock: /api/proxies and
 * /api/stock-accounts.
 *
 * /api/stock-accounts and not /api/accounts, because that path already means
 * the software's accounts -- the ones handed targets and metered by the caps
 * -- and a PATCH landing on the wrong kind of account because two routes
 * differed only in guard would be a miserable bug to read.
 *
 * Guarded like every /api route: the operator's cookie resolves to the
 * client, exactly as ApiKeyGuard resolves a key. That a machine's key COULD
 * technically reach these is the same standing fact as for /api/onboarding;
 * what keeps the stock "only for us" is that no agent build has ever been
 * told these routes exist and nothing in /v1 serves them.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsString, MaxLength } from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { StockService } from './stock.service';

/** One paste. The cap is on the body, not the count -- 200KB is thousands of
 *  lines, and a file bigger than that is not a proxy list. */
export class ImportStockDto {
  @IsString()
  @MaxLength(200_000)
  text!: string;
}

/** `deployed` is the one patchable thing, so it is required rather than
 *  optional-with-nothing-else: an empty PATCH is a caller bug and gets a 400
 *  naming the field, not a silent no-op. */
export class PatchStockAccountDto {
  @IsBoolean()
  deployed!: boolean;
}

@Controller('api/proxies')
@UseGuards(ApiKeyGuard)
export class ProxiesController {
  constructor(private readonly stock: StockService) {}

  @Get()
  list(@Req() req: any) {
    return this.stock.listProxies(req.client.id);
  }

  /** Paste a seller's list in. -> what became of every line of it. */
  @Post()
  importProxies(@Body() dto: ImportStockDto, @Req() req: any) {
    return this.stock.importProxies(req.client.id, dto.text);
  }

  /** Answers with how many accounts it left unassigned, so the screen can say
   *  so instead of the operator discovering it row by row. */
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.stock.deleteProxy(req.client.id, id);
  }
}

@Controller('api/stock-accounts')
@UseGuards(ApiKeyGuard)
export class StockAccountsController {
  constructor(private readonly stock: StockService) {}

  @Get()
  list(@Req() req: any) {
    return this.stock.listAccounts(req.client.id);
  }

  /** Paste `user:pass` lines in. Every new row is put behind a proxy here,
   *  in the same call -- "added but never assigned" is not a state. */
  @Post()
  importAccounts(@Body() dto: ImportStockDto, @Req() req: any) {
    return this.stock.importAccounts(req.client.id, dto.text);
  }

  /** The repair button: deal proxies to every account that has none. */
  @Post('assign-unassigned')
  assignUnassigned(@Req() req: any) {
    return this.stock.assignUnassigned(req.client.id);
  }

  /** Assign or re-roll one account's proxy, drawn as the import draws. */
  @Post(':id/assign')
  assignOne(@Param('id') id: string, @Req() req: any) {
    return this.stock.assignOne(req.client.id, id);
  }

  @Patch(':id')
  patch(@Param('id') id: string, @Body() dto: PatchStockAccountDto, @Req() req: any) {
    return this.stock.setDeployed(req.client.id, id, dto.deployed);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.stock.deleteAccount(req.client.id, id);
  }
}
