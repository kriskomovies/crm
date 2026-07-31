import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PipelineService } from './pipeline.service';

/**
 * Where an uploaded sheet goes to be extracted.
 *
 * Normally onto the BullMQ queue, so a worker container picks it up and the API
 * is free to answer the next request -- an extraction holds an HTTP call open
 * for 45-75 seconds and must never sit in the request path.
 *
 * QUEUE_DRIVER=inline runs it in this process instead. That exists because a
 * machine with no Redis accepts uploads, writes the Sheet row, enqueues into
 * nothing, and answers 202 -- so the client sees a jobId that will never
 * progress and every sheet sits in 'received' forever. Silent, and it looks
 * exactly like a slow model. Development and single-box installs need a mode
 * where the work actually happens.
 *
 * Inline is NOT a production mode: the extraction competes with request
 * handling in the same event loop, and nothing retries it if the process dies
 * mid-flight. docker-compose runs Redis and a separate worker for that reason.
 */
@Injectable()
export class ExtractDispatcher {
  private readonly log = new Logger(ExtractDispatcher.name);
  private readonly inline = (process.env.QUEUE_DRIVER ?? 'queue') === 'inline';

  constructor(
    @InjectQueue('extract') private readonly queue: Queue,
    private readonly pipeline: PipelineService,
  ) {
    if (this.inline) {
      this.log.warn('QUEUE_DRIVER=inline: extracting in-process, no worker, no retries');
    }
  }

  async dispatch(sheetId: string): Promise<void> {
    if (!this.inline) {
      // jobId = sheet id so a duplicate enqueue after a crash-and-retry
      // collapses onto the same job rather than paying for a second call.
      await this.queue.add('extract', { sheetId }, { jobId: sheetId });
      return;
    }
    // Deliberately not awaited: the caller owes the client a 202 now, not in a
    // minute. A rejection here would otherwise be an unhandled rejection and
    // take the process down, so the failure is logged and left in the Sheet
    // row, which is where the client polls for it anyway.
    void this.pipeline.run(sheetId).catch((err: unknown) => {
      this.log.error(
        `inline extraction failed for ${sheetId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
