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
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { PersonalitiesService } from './personalities.service';

class CreatePersonalityDto {
  @IsString()
  @MaxLength(80)
  name!: string;
}

class CreateAccountDto {
  @IsString()
  @MaxLength(80)
  label!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  dailyCap?: number;
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

class UpdateAccountDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  dailyCap?: number;

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
    return this.personalities.addAccount(req.client.id, id, dto.label, dto.dailyCap);
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

  @Post(':id/targets')
  attach(@Param('id') id: string, @Body() dto: AttachTargetsDto, @Req() req: any) {
    return this.personalities.attach(req.client.id, id, dto.handles, dto.source ?? 'manual');
  }

  /**
   * The review queue. The service method existed and was reachable from
   * nothing: no route mapped to it, so the screen the near-duplicate guard
   * feeds answered 404 while the guard quietly filled it.
   */
  @Get(':id/review')
  review(
    @Param('id') id: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Req() req: any,
    @Query('cursor') cursor?: string,
  ) {
    return this.personalities.review(req.client.id, id, limit, cursor);
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
}
