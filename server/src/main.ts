import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });

  // The React app generates its typed client from this document, which is how
  // staying off NestJS-shared-types costs nothing on the frontend side.
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Follow-target service')
      .setDescription('Sheet ingest, per-personality dedupe ledger, metered target handout')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, doc);

  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
