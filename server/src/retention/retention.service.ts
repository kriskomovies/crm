/**
 * Deletes stored sheet images once nothing will ask for them again.
 *
 * The image is read exactly once, by the extraction call. Nothing reads it
 * afterwards: the CRM has no screen that displays it, and the replay that IS
 * implemented -- re-running filter/allocate after a rule change -- reads
 * Extraction.rawReply, never the pixels. So the default is to delete it the
 * moment the pipeline finishes with it, and storage stays flat at roughly the
 * number of sheets in flight instead of growing ~24 GB/day forever.
 *
 * SHEET_RETENTION_DAYS
 *   0   delete as soon as the pipeline completes           (default)
 *   N   keep N days, then sweep
 *   <0  keep forever
 *
 * SHEET_FAILED_RETENTION_DAYS (default 7)
 *   Failed and rejected sheets keep their image for this long whatever the
 *   above says. They are the only ones worth looking at -- when a sheet comes
 *   back garbled you cannot tell a bad capture from a bad model without the
 *   image -- and they are rare, so the window is nearly free.
 *
 * WHY NOT DELETE THE INSTANT EXTRACTION RETURNS: run() continues into resolve,
 * filter and allocate. A throw in any of them fails the job, BullMQ retries it,
 * and run() reads storageKey again. Deleting at the end of extract() would turn
 * every transient database error in the second half of the pipeline into a
 * permanent loss of the sheet. The deletion hook is called after allocate, when
 * the whole pipeline has committed.
 *
 * What is never deleted: the Sheet row, a few hundred bytes carrying the cost
 * and throughput history /api/stats reports and the (accountId, sha256)
 * uniqueness that makes a client's retry free; and Extraction.rawReply, the
 * model's verbatim answer.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SheetStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/** The pipeline ran to completion. Nothing will ask for the image again. */
const SUCCEEDED: SheetStatus[] = [SheetStatus.extracted, SheetStatus.partial];

/** Terminal, but worth keeping the evidence for a while. */
const FAILED: SheetStatus[] = [SheetStatus.failed, SheetStatus.rejected];

/**
 * How many to delete per sweep pass. Object deletes are one round trip each,
 * so an unbounded sweep after a long outage would hold the loop for hours; it
 * simply resumes on the next tick.
 */
const BATCH = 500;

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly days = Number(process.env.SHEET_RETENTION_DAYS ?? 0);
  private readonly failedDays = Number(process.env.SHEET_FAILED_RETENTION_DAYS ?? 7);
  private readonly everyMs =
    Number(process.env.RETENTION_SWEEP_MINUTES ?? 60) * 60_000;

  /**
   * This service lives in CoreModule, which both entrypoints import, so without
   * a switch the API and the worker would each sweep on their own timer --
   * selecting the same rows and racing on the same keys. Compose sets
   * RETENTION_SWEEP=off on the api and leaves the worker to it.
   *
   * Default ON so a single-process deployment still prunes: with
   * QUEUE_DRIVER=inline there is no worker at all. The two request-driven
   * paths, onPipelineComplete and purgeKeys, ignore this flag entirely -- they
   * must run wherever the work lands.
   */
  private readonly sweeps = (process.env.RETENTION_SWEEP ?? 'on') !== 'off';

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    this.log.log(
      this.days === 0
        ? 'retention: deleting sheet images as soon as the pipeline completes' +
            `, failures kept ${this.failedDays}d`
        : this.days < 0
          ? 'retention: keeping every sheet image forever (SHEET_RETENTION_DAYS<0)'
          : `retention: keeping sheet images ${this.days}d, failures ${this.failedDays}d`,
    );
    if (!this.sweeps) {
      this.log.log('retention: sweeping disabled in this process (RETENTION_SWEEP=off)');
      return;
    }
    // The sweep runs even when days is 0. The immediate delete is the fast
    // path, not the guarantee: a crash between allocate and the unlink, or a
    // sheet that failed and has now aged out, both leave objects only the sweep
    // will ever find.
    this.timer = setInterval(() => void this.sweep(), this.everyMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The pipeline has fully committed for this sheet: extracted, resolved,
   * filtered and allocated. With SHEET_RETENTION_DAYS=0 this is where the image
   * goes -- immediately, rather than sitting on disk until a sweep notices it.
   *
   * Never throws. A sheet whose image could not be deleted is a storage problem,
   * not a pipeline problem, and failing the job here would re-run a vision call
   * that already succeeded and cost money.
   */
  async onPipelineComplete(sheetId: string, storageKey: string | null): Promise<void> {
    if (this.days !== 0 || !storageKey) return;
    try {
      await this.storage.remove(storageKey);
      await this.prisma.sheet.update({
        where: { id: sheetId },
        data: { storageKey: null },
      });
    } catch (err) {
      // Left for the sweep, which retries every object it still sees a pointer
      // to. Warn, not error: the sheet itself is fine.
      this.log.warn(
        `retention: immediate delete failed for sheet ${sheetId}, leaving it to the sweep: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * One pass. Public so a deployment can trigger it directly and so tests can
   * drive it without waiting an hour for a timer.
   */
  async sweep(now = new Date()): Promise<{ deleted: number; failed: number }> {
    if (this.running) {
      // A sweep that overruns its interval must not run twice concurrently:
      // both passes would select the same rows and race on the same keys.
      this.log.warn('retention: previous sweep still running, skipping this tick');
      return { deleted: 0, failed: 0 };
    }
    this.running = true;
    try {
      let deleted = 0;
      let failed = 0;

      if (this.days >= 0) {
        // days === 0 means "no age condition at all": anything that completed
        // and still has a pointer is overdue by definition.
        const cutoff = this.days === 0 ? null : this.ago(now, this.days);
        const r = await this.prune(SUCCEEDED, cutoff);
        deleted += r.deleted;
        failed += r.failed;
      }

      if (this.failedDays >= 0) {
        const r = await this.prune(FAILED, this.ago(now, this.failedDays));
        deleted += r.deleted;
        failed += r.failed;
      }

      if (deleted || failed) {
        this.log.log(
          `retention: deleted ${deleted} sheet image(s)` +
            (failed ? `, ${failed} failed` : ''),
        );
      }
      return { deleted, failed };
    } finally {
      this.running = false;
    }
  }

  private ago(now: Date, days: number): Date {
    return new Date(now.getTime() - days * 86_400_000);
  }

  /** @param cutoff null means no age condition. */
  private async prune(
    statuses: SheetStatus[],
    cutoff: Date | null,
  ): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;

    for (;;) {
      const batch = await this.prisma.sheet.findMany({
        where: {
          storageKey: { not: null },
          status: { in: statuses },
          ...(cutoff ? { receivedAt: { lt: cutoff } } : {}),
        },
        select: { id: true, storageKey: true },
        orderBy: { receivedAt: 'asc' },
        take: BATCH,
      });
      if (batch.length === 0) break;

      for (const sheet of batch) {
        try {
          await this.storage.remove(sheet.storageKey!);
          await this.prisma.sheet.update({
            where: { id: sheet.id },
            data: { storageKey: null },
          });
          deleted++;
        } catch (err) {
          // Leave storageKey set. The object may still exist, and a pointer to
          // a live object is recoverable where a null pointer to one is not:
          // nothing could ever find that object again to delete it.
          failed++;
          this.log.error(
            `retention: could not delete ${sheet.storageKey} for sheet ${sheet.id}: ${
              (err as Error).message
            }`,
          );
        }
      }

      // A batch that failed entirely would loop forever re-selecting the same
      // rows, since nothing about them changed.
      if (batch.length < BATCH || deleted === 0) break;
    }

    return { deleted, failed };
  }

  /**
   * Delete the images for a set of sheets right now, regardless of age or
   * status.
   *
   * Used when a personality is deleted: the cascade destroys the Sheet rows and
   * with them every storageKey, so unless the objects go first they become
   * unreferenceable -- still on disk, with nothing left in the database that
   * knows their names.
   */
  async purgeKeys(keys: (string | null)[]): Promise<number> {
    let gone = 0;
    for (const key of keys) {
      if (!key) continue;
      try {
        await this.storage.remove(key);
        gone++;
      } catch (err) {
        this.log.error(`retention: purge failed for ${key}: ${(err as Error).message}`);
      }
    }
    return gone;
  }
}
