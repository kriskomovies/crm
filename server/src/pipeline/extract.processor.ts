import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PipelineService } from './pipeline.service';

/**
 * Runs extractions off the request path.
 *
 * Concurrency is high and that is deliberate: a job is 45-75 seconds of waiting
 * on the gateway, not of CPU. At 20,000 sheets/day roughly 14 need to be in
 * flight at once, and in Node those are 14 idle promises in one process rather
 * than 14 OS processes.
 */
@Processor('extract', {
  concurrency: Number(process.env.EXTRACT_CONCURRENCY ?? 16),
})
export class ExtractProcessor extends WorkerHost {
  private readonly log = new Logger(ExtractProcessor.name);

  constructor(private readonly pipeline: PipelineService) {
    super();
  }

  async process(job: Job<{ sheetId: string }>): Promise<void> {
    const { sheetId } = job.data;
    this.log.log(`extracting sheet ${sheetId} (attempt ${job.attemptsMade + 1})`);
    await this.pipeline.run(sheetId);
  }
}
