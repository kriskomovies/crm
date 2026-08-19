import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ApiKeyGuard } from './auth/api-key.guard';
import { SessionController } from './auth/session.controller';
import { SessionService } from './auth/session.service';
import { CrmController } from './crm/crm.controller';
import { RulesController } from './crm/rules.controller';
import {
  EnrolmentController,
  MachineEnrolmentController,
} from './enrolment/enrolment.controller';
import { EnrolmentService } from './enrolment/enrolment.service';
import { ExtractDispatcher } from './pipeline/extract.dispatcher';
import { GatewayClient } from './extraction/gateway.client';
import { OnboardingController } from './onboarding/onboarding.controller';
import { AccountsController, PersonalitiesController } from './personalities/personalities.controller';
import { PersonalitiesService } from './personalities/personalities.service';
import { ExtractProcessor } from './pipeline/extract.processor';
import { PipelineService } from './pipeline/pipeline.service';
import { PrismaService } from './prisma/prisma.service';
import { RetentionService } from './retention/retention.service';
import { SettingsController } from './settings/settings.controller';
import { SheetsController } from './sheets/sheets.controller';
import { StatsController } from './stats/stats.controller';
import { StatsService } from './stats/stats.service';
import { StorageService } from './storage/storage.service';
import { PersonalityLedgerController, TargetsController } from './targets/targets.controller';
import { TargetsService } from './targets/targets.service';

/** Shared by both entrypoints; the worker imports this without the controllers. */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
      defaultJobOptions: {
        // Extraction is idempotent per sheet, so retrying is safe; the backoff
        // is generous because the usual cause is the gateway asking us to wait.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 86400, count: 5000 },
        removeOnFail: { age: 604800 },
      },
    }),
    BullModule.registerQueue({ name: 'extract' }),
  ],
  providers: [
    PrismaService,
    StorageService,
    GatewayClient,
    PipelineService,
    ExtractDispatcher,
    TargetsService,
    PersonalitiesService,
    StatsService,
    RetentionService,
    EnrolmentService,
    SessionService,
    ApiKeyGuard,
  ],
  exports: [
    PrismaService,
    StorageService,
    GatewayClient,
    PipelineService,
    ExtractDispatcher,
    TargetsService,
    PersonalitiesService,
    StatsService,
    RetentionService,
    EnrolmentService,
    SessionService,
  ],
})
export class CoreModule {}

@Module({
  imports: [CoreModule, BullModule.registerQueue({ name: 'extract' })],
  controllers: [
    SheetsController,
    TargetsController,
    PersonalityLedgerController,
    PersonalitiesController, AccountsController,
    SettingsController,
    StatsController,
    CrmController,
    RulesController,
    MachineEnrolmentController,
    EnrolmentController,
    SessionController,
    OnboardingController,
  ],
})
export class AppModule {}

/** The worker runs the processor and no HTTP surface at all. */
@Module({
  imports: [CoreModule],
  providers: [ExtractProcessor],
})
export class WorkerModule {}
