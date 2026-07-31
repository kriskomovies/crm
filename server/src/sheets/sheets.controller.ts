/**
 * Sheet ingest.
 *
 * Returns 202 and a job id rather than the extracted profiles, because one
 * extraction holds an HTTP call open for 45-75 seconds -- long enough that a
 * synchronous upload would time out on any sensible proxy.
 *
 * Uploading the same image twice is free and returns the original job: the
 * content hash is unique per account, so a client retrying after a dropped
 * connection cannot be billed twice for the same vision call.
 */
import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { ExtractDispatcher } from '../pipeline/extract.dispatcher';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const MAX_BYTES = 25 * 1024 * 1024;

@Controller('v1/accounts/:accountId/sheets')
@UseGuards(ApiKeyGuard)
export class SheetsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly dispatcher: ExtractDispatcher,
  ) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_BYTES } }))
  async upload(
    @Param('accountId') accountId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('no image uploaded');

    const account = await this.prisma.account.findFirst({
      where: { id: accountId, personality: { clientId: req.client.id } },
      include: { personality: true },
    });
    if (!account) throw new NotFoundException('account not found');
    if (!account.enabled) throw new BadRequestException('account is disabled');

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const existing = await this.prisma.sheet.findUnique({
      where: { accountId_sha256: { accountId, sha256 } },
      select: { id: true, status: true },
    });
    if (existing) {
      // The row is created before the enqueue, so a Redis outage between the two
      // leaves a sheet 'received' with no job behind it -- and because this
      // branch returns first, every later retry of the same bytes confirmed a
      // job that would never run. That is the exact shape of a client spooling
      // through an outage and replaying afterwards, so the replay has to be what
      // heals it. Safe to re-add: run() sets 'extracting' as its first act, so
      // 'received' means no worker ever took it, and jobId = sheet id makes an
      // enqueue that did land collapse onto the same job rather than paying for
      // a second vision call.
      if (existing.status === 'received') {
        await this.dispatcher.dispatch(existing.id);
      }
      return { jobId: existing.id, status: existing.status, duplicate: true };
    }

    const key = this.storage.key(req.client.id, sha256);
    await this.storage.put(key, file.buffer, file.mimetype || 'image/png');

    const sheet = await this.prisma.sheet.create({
      data: { accountId, sha256, storageKey: key, status: 'received' },
    });
    await this.dispatcher.dispatch(sheet.id);

    return { jobId: sheet.id, status: sheet.status, duplicate: false };
  }

  @Get(':jobId')
  async status(
    @Param('accountId') accountId: string,
    @Param('jobId') jobId: string,
    @Req() req: any,
  ) {
    const sheet = await this.prisma.sheet.findFirst({
      where: { id: jobId, accountId, account: { personality: { clientId: req.client.id } } },
      select: {
        id: true,
        status: true,
        error: true,
        // Two fields, not `include: { extraction: true }`. That also reads
        // rawReply -- the verbatim VLM answer, tens of KB -- and a client polls
        // this every few seconds for the minute a job takes.
        extraction: { select: { profilesFound: true, usd: true } },
        _count: { select: { people: true } },
      },
    });
    if (!sheet) throw new NotFoundException('job not found');

    const queued = await this.prisma.assignment.count({
      where: { accountId, person: { firstSeenSheetId: sheet.id }, state: 'queued' },
    });

    return {
      jobId: sheet.id,
      status: sheet.status,
      error: sheet.error,
      profilesFound: sheet.extraction?.profilesFound ?? 0,
      newPeople: sheet._count.people,
      queued,
      // Number(), because a Prisma Decimal serialises as a JSON string. This
      // field was a string once a sheet had been extracted and the number 0
      // before that, so a client doing arithmetic on it got NaN exactly when
      // there was finally something to add up.
      costUsd: Number(sheet.extraction?.usd ?? 0),
    };
  }
}
