import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './app.module';

/**
 * Queue worker. Same image as the API, different entrypoint -- so extraction
 * scales by adding worker containers without touching the HTTP tier.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // Nothing else to do: the BullMQ processor is started by the module and runs
  // until the container stops.
}

void bootstrap();
