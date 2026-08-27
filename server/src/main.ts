import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Express body-parser defaults to a 100 KB JSON body, and several endpoints
  // accept a pasted list far larger than that on purpose: onboarding handles
  // and the proxy/stock-account imports all cap their `text` field at 200 KB in
  // the DTO. Without this the DTO ceiling is unreachable -- a 150 KB seller file
  // dies with a generic 413 in middleware, before ValidationPipe runs, so none
  // of the per-line "added / duplicate / not a proxy" reporting those screens
  // are built around is ever produced. 512 KB clears the 200 KB of text plus
  // JSON-escaping overhead with room to spare; the DTO length cap is still the
  // real limit, enforced after the body is read. Sheet uploads are multipart
  // (multer), a separate parser this does not touch.
  app.useBodyParser('json', { limit: '512kb' });

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
