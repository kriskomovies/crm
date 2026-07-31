/**
 * A real HTTP server in front of the real AppModule.
 *
 * Everything else in test/ calls services directly, which is the right shape for
 * asking whether the ledger is consistent -- and completely blind to the layer
 * this file exists to exercise. A guard, a route path, a DTO and a pipe are not
 * reachable from a service call: they only exist between a socket and the
 * controller. `personalities.targets(clientId, ...)` cannot tell you that
 * /api/personalities/:id/targets forgot @UseGuards, because the test is the one
 * supplying clientId.
 *
 * So this boots AppModule through Nest's own DI, binds it to an ephemeral port
 * and talks to it over TCP with fetch. Two providers are replaced and nothing
 * else:
 *
 *   - the 'extract' BullMQ queue, because this machine has no Redis. Overriding
 *     the token means the provider factory never runs, so no ioredis connection
 *     is opened and no reconnect storm outlives the suite. Registering the queue
 *     twice (CoreModule and AppModule) is fine -- an override is by token.
 *   - GatewayClient, because a test that reaches the vision gateway costs money
 *     and answers differently every run. It is wired to throw rather than to
 *     return a stub: no route in this suite should be calling it, and a silent
 *     stub would hide the day one starts.
 *
 * PrismaService is NOT overridden. The dev cluster is the point: tenant
 * isolation is a property of the WHERE clauses that reach Postgres, and a mocked
 * client would be asserting the mock.
 *
 * WHY THE PIPE IS RE-DECLARED HERE: main.ts installs the global ValidationPipe
 * inside bootstrap(), after NestFactory.create, so it is not part of AppModule
 * and no consumer of AppModule inherits it. This harness therefore has to
 * restate the same options, which means these tests verify that THIS
 * configuration rejects what it should -- not that main.ts is configured this
 * way. Keep the two in sync by hand until the pipe moves into AppModule as an
 * APP_PIPE provider, at which point delete the block below and the suite starts
 * testing the real thing.
 */
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';

import { AppModule } from '../../src/app.module';
import { GatewayClient } from '../../src/extraction/gateway.client';

export interface HttpResponse<T = any> {
  status: number;
  /** Parsed JSON, or undefined for an empty body such as a 204. */
  body: T;
  text: string;
  headers: Headers;
}

export interface RequestOptions {
  /** Sent verbatim as Authorization. Omit the field entirely to send no header. */
  auth?: string;
  /** Serialised as JSON. Pass a string to send a body the DTO cannot parse. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface EnqueuedJob {
  name: string;
  data: unknown;
  opts: unknown;
}

export class Harness {
  constructor(
    private readonly app: INestApplication,
    readonly base: string,
    /** Everything SheetsController pushed at the queue, in order. */
    readonly enqueued: EnqueuedJob[],
  ) {}

  async request<T = any>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    // Distinguishes "no Authorization header" from "Authorization: " -- both are
    // rejections the guard has to make, and they are different requests.
    if (opts.auth !== undefined) headers.authorization = opts.auth;

    let payload: string | undefined;
    if (opts.body !== undefined) {
      payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      headers['content-type'] ??= 'application/json';
    }

    const res = await fetch(`${this.base}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let body: any;
    try {
      body = text.length ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: res.status, body, text, headers: res.headers };
  }

  get<T = any>(path: string, opts?: RequestOptions) {
    return this.request<T>('GET', path, opts);
  }
  post<T = any>(path: string, opts?: RequestOptions) {
    return this.request<T>('POST', path, opts);
  }
  patch<T = any>(path: string, opts?: RequestOptions) {
    return this.request<T>('PATCH', path, opts);
  }
  delete<T = any>(path: string, opts?: RequestOptions) {
    return this.request<T>('DELETE', path, opts);
  }

  /**
   * Every path Express actually routes, as "METHOD /path".
   *
   * Read off the router rather than off a list in a test file, so a controller
   * added next month appears here whether or not anyone remembered this suite.
   */
  routes(): string[] {
    const express: any = this.app.getHttpAdapter().getInstance();
    // Express 5 exposes `router`; 4 kept it on `_router`. Both are internal, so
    // the fallback matters more than which one is current.
    const router = express.router ?? express._router;
    const out: string[] = [];
    for (const layer of router?.stack ?? []) {
      const route = layer.route;
      if (!route) continue;
      const path: string = route.path ?? layer.path ?? '';
      const methods: Record<string, boolean> = route.methods ?? {};
      for (const method of Object.keys(methods)) {
        if (method === '_all') continue;
        out.push(`${method.toUpperCase()} ${path}`);
      }
    }
    return out.sort();
  }

  close(): Promise<void> {
    return this.app.close();
  }
}

export async function bootHarness(): Promise<Harness> {
  const enqueued: EnqueuedJob[] = [];

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(getQueueToken('extract'))
    .useValue({
      add: async (name: string, data: unknown, opts: unknown) => {
        enqueued.push({ name, data, opts });
        return { id: (opts as any)?.jobId ?? name };
      },
      close: async () => undefined,
    })
    .overrideProvider(GatewayClient)
    .useValue({
      ask: async () => {
        throw new Error('the HTTP suite must not reach the vision gateway');
      },
    })
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // Port 0: the dev API already owns :3000 and must keep it. Binding to
  // 127.0.0.1 rather than 0.0.0.0 also keeps getUrl()'s ::1-vs-127.0.0.1
  // ambiguity out of the base URL.
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return new Harness(app, `http://127.0.0.1:${port}`, enqueued);
}
