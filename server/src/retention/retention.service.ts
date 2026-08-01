/**
 * Deletes stored sheet images once they are older than the retention window.
 *
 * Without this the service has two write paths into object storage and no
 * delete path at all. A sheet is ~1.2 MB and the design target is 20,000 a day,
 * so storage grows ~24 GB a day and ~8.8 TB a year on a single VPS volume, and
 * every byte of it is an image that was read exactly once -- by the extraction
 * call -- and never again.
 *
 * What is kept and what goes:
 *
 *   the Sheet row      KEPT. It is a few hundred bytes, it carries the cost and
 *                      throughput history /api/stats reports, and its
 *                      (accountId, sha256) uniqueness is what makes a client's
 *                      re-upload after a network blip free instead of a second
 *                      vision call.
 *   Extraction.rawReply KEPT. It is the model's verbatim answer, ~18 KB before
 *                      TOAST compression, and it is what lets filter and
 *                      allocate be replayed after a rule change without paying
 *                      for vision again. Replay reads this, never the image.
 *   the image          DELETED after RETENTION_DAYS.
 *
 * Only sheets in a TERMINAL status are pruned. A sheet still `received` or
 * `extracting` has a queued job that will ask for its bytes, and deleting them
 * underneath it would turn a retry into a permanent failure.
 *
 * The sweep is idempotent and safe to interrupt: storage.remove treats a
 * missing key as success, and storageKey is nulled only after the object is
 * gone, so a crash mid-sweep leaves at worst an already-deleted object still
 * pointed at, which the next sweep resolves.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SheetStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/** Statuses where no queued job will ever ask for the image again. */
const TERMINAL: SheetStatus[] = [
  SheetStatus.extracted,
  SheetStatus.partial,
  SheetStatus.failed,
  SheetStatus.rejected,
];

/**
 * How many to delete per sweep pass. Object deletes are one round trip each,
 * so an unbounded sweep after a long outage would hold the loop for hours;
 * the sweep simply resumes on the next tick.
 */
const BATCH = 500;

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /**
   * 0 disables retention and keeps every image forever, which is the old
   * behaviour and a legitimate choice for a small deployment. It is opt-out
   * rather than opt-in because the failure mode of forgetting to set it is a
   * full disk.
   */
  private readonly days = Number(process.env.SHEET_RETENTION_DAYS ?? 14);
  private readonly everyMs =
    Number(process.env.RETENTION_SWEEP_MINUTES ?? 60) * 60_000;

  /**
   * This service lives in CoreModule, which both entrypoints import, so without
   * a switch the API and the worker would each sweep on their own timer --
   * selecting the same rows and racing on the same keys. Compose sets
   * RETENTION_SWEEP=off on the api service and leaves the worker to it.
   *
   * The default is ON so that a single-process deployment still prunes: with
   * QUEUE_DRIVER=inline there is no worker at all, and a default of off would
   * mean the disk quietly fills on exactly the small setups least able to
   * absorb it. purgeKeys stays callable either way -- it is request-driven, not
   * swept, and PersonalitiesService needs it in the API process.
   */
  private readonly sweeps = (process.env.RETENTION_SWEEP ?? 'on') !== 'off';

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    if (!this.sweeps) {
      this.log.log('retention: sweeping disabled in this process (RETENTION_SWEEP=off)');
      return;
    }
    if (!(this.days > 0)) {
      this.log.warn(
        'SHEET_RETENTION_DAYS is 0 or unset-to-zero: sheet images are kept forever. ' +
          'At the 20k/day design target that is ~24 GB/day.',
      );
      return;
    }
    this.log.log(
      `retention: deleting sheet images older than ${this.days}d, sweeping every ${
        this.everyMs / 60_000
      }m`,
    );
    // unref so a pending sweep timer never holds the process open on shutdown.
    this.timer = setInterval(() => void this.sweep(), this.everyMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Public so a deployment can trigger it directly and so the tests
   * can drive it without waiting an hour for a timer.
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
      return await this.prune(new Date(now.getTime() - this.days * 86_400_000));
    } finally {
      this.running = false;
    }
  }

  private async prune(cutoff: Date): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;

    for (;;) {
      const batch = await this.prisma.sheet.findMany({
        where: {
          storageKey: { not: null },
          receivedAt: { lt: cutoff },
          status: { in: TERMINAL },
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

      if (batch.length < BATCH) break;
    }

    if (deleted || failed) {
      this.log.log(
        `retention: deleted ${deleted} sheet image(s) older than ${cutoff.toISOString()}` +
          (failed ? `, ${failed} failed` : ''),
      );
    }
    return { deleted, failed };
  }

  /**
   * Delete the images for a set of sheets right now, regardless of age.
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
