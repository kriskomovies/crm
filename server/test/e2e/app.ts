/**
 * The e2e harness: the real AppModule, on a real socket, in front of the real
 * Postgres, with exactly one thing replaced.
 *
 * WHAT IS REAL. Nest builds the whole application graph, so the requests these
 * tests make go through the same Express server, the same ApiKeyGuard, the same
 * ValidationPipe main.ts installs, the same multer file interceptor and the same
 * JSON serialisation as production. Nothing calls a controller method directly
 * and nothing hands itself a `req.client` -- every test authenticates with a key
 * whose sha256 is in the database, and a test that gets the key wrong gets a 401
 * like anyone else. Below the controllers, PipelineService, PrismaService,
 * StorageService and TargetsService are the real classes against the real dev
 * cluster on 127.0.0.1:5433.
 *
 * WHAT IS FAKE, AND WHY. Two providers are overridden.
 *
 *   GatewayClient -- the network call to the VLM. Stubbed because it costs money
 *   and 45-75 seconds per sheet, and because an answer that changes run to run
 *   cannot be asserted on. It returns RECORDED replies (see test/recorded), so
 *   everything downstream of `fetch` -- the SSE-free text, the parser, the
 *   salvage path, the cues guard, normalisation, the ledger -- is the real code
 *   reading real model output.
 *
 *   The 'extract' BullMQ queue. Stubbed because there is no Redis on this
 *   machine, so the alternative is not "a slower test" but "no test at all".
 *   THE COST IS REAL AND IS NOT HIDDEN: with the queue faked, the upload path is
 *   covered up to and including the enqueue -- that a job is added, once, with
 *   jobId = sheetId -- and the pipeline is covered by driving it exactly as
 *   ExtractProcessor does, `pipeline.run(sheetId)`. What is NOT covered is
 *   everything between those two points: that BullMQ serialises and delivers the
 *   job, that @Processor('extract') is wired to it, that jobId collapses a
 *   duplicate enqueue, that attempts/backoff retry a failure, and that an
 *   UnrecoverableError stops the retries instead of buying three more vision
 *   calls. Those need a Redis and are untested here. Tests assert on
 *   `harness.queue.jobs` so at least the contract the worker consumes is pinned.
 */
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppModule } from '../../src/app.module';
import { AskOptions, AskResult, GatewayClient } from '../../src/extraction/gateway.client';
import { PipelineService } from '../../src/pipeline/pipeline.service';
import { prisma } from '../fixtures';
import { RecordedReply } from '../recorded';

/** One `ask()` the pipeline made, kept so a test can prove it was or was not made. */
export interface GatewayCall {
  model: string;
  prompt: string;
  /** Decoded length of the image the pipeline read back out of storage. */
  imageBytes: number;
  imageMime: string;
}

/**
 * Stands in for the HTTP call to api.apimart.ai.
 *
 * Replies are scripted in order rather than keyed by image, because the thing
 * under test is what the pipeline does with an answer, and one account uploading
 * the same screenshot twice must be able to get two different answers -- which
 * is exactly the near-duplicate case.
 *
 * An unscripted call throws instead of returning something plausible. A test
 * that triggers an extraction it did not expect is a test that has stopped
 * measuring what it claims to.
 */
export class FakeGateway {
  readonly calls: GatewayCall[] = [];
  private readonly queue: (RecordedReply | Error)[] = [];
  private scripted = 0;

  script(...replies: (RecordedReply | Error)[]): this {
    this.queue.push(...replies);
    this.scripted += replies.length;
    return this;
  }

  async ask(o: AskOptions): Promise<AskResult> {
    const image = o.images[0] ?? '';
    const comma = image.indexOf(',');
    this.calls.push({
      model: o.model,
      prompt: o.prompt,
      imageBytes: comma < 0 ? 0 : Buffer.from(image.slice(comma + 1), 'base64').length,
      imageMime: comma < 0 ? '' : image.slice(5, image.indexOf(';')),
    });

    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `unscripted extraction: the gateway has now been asked ${this.calls.length} time(s) ` +
          `and only ${this.scripted} repl(ies) were scripted`,
      );
    }
    if (next instanceof Error) throw next;

    return {
      text: next.text,
      seconds: next.seconds,
      finishReason: 'stop',
      promptTokens: next.promptTokens,
      completionTokens: next.completionTokens,
      imageTokens: null,
      quirks: [],
    };
  }
}

export interface QueuedJob {
  name: string;
  data: { sheetId: string };
  opts: { jobId?: string } | undefined;
}

/** Records what the controller enqueued. See the header for what this gives up. */
export class FakeQueue {
  readonly jobs: QueuedJob[] = [];

  async add(name: string, data: { sheetId: string }, opts?: { jobId?: string }) {
    this.jobs.push({ name, data, opts });
    return { id: opts?.jobId ?? String(this.jobs.length) };
  }
}

export interface HttpResponse<T = any> {
  status: number;
  body: T;
  text: string;
}

/** A client of the API, holding one tenant's key. Real requests, real headers. */
export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly apiKey: string | null,
  ) {}

  /** The same surface with a different key -- for proving the guard is real. */
  withKey(apiKey: string | null): ApiClient {
    return new ApiClient(this.base, apiKey);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}`, ...extra } : extra;
  }

  private async wrap(res: Response): Promise<HttpResponse> {
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, text };
  }

  async get(path: string): Promise<HttpResponse> {
    return this.wrap(await fetch(`${this.base}${path}`, { headers: this.headers() }));
  }

  async post(path: string, json?: unknown): Promise<HttpResponse> {
    return this.wrap(
      await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: this.headers(json === undefined ? {} : { 'content-type': 'application/json' }),
        body: json === undefined ? undefined : JSON.stringify(json),
      }),
    );
  }

  /** multipart/form-data, the way the emulator uploads. */
  async upload(path: string, image: Buffer, filename = 'sheet.png'): Promise<HttpResponse> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), filename);
    return this.wrap(
      await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: form,
      }),
    );
  }
}

export interface Harness {
  app: INestApplication;
  base: string;
  gateway: FakeGateway;
  queue: FakeQueue;
  /** The application's own PipelineService, from the application's own container. */
  pipeline: PipelineService;
  /**
   * Run every sheet the controller has enqueued since the last drain, exactly as
   * ExtractProcessor would: `pipeline.run(job.data.sheetId)`.
   *
   * Errors are returned rather than thrown. `run` rethrows on purpose so BullMQ
   * can retry, and the rejected/failed paths are the ones worth asserting on.
   */
  drainQueue(): Promise<{ sheetId: string; error: Error | null }[]>;
  api(apiKey: string): ApiClient;
  close(): Promise<void>;
}

export async function bootHarness(): Promise<Harness> {
  // Absolute, and per-run: StorageService resolves this at construction, so it
  // has to be set before the container is built. Keeping uploads out of
  // server/.storage means the suite cannot collide with the dev API that is
  // already running against the same directory, and cleanup is one rmSync.
  const storageDir = mkdtempSync(join(tmpdir(), 'snap-e2e-'));
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_DIR = storageDir;

  const gateway = new FakeGateway();
  const queue = new FakeQueue();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GatewayClient)
    .useValue(gateway)
    // Both CoreModule and AppModule register this queue; the token is the same
    // string, so one override replaces both and no BullMQ client is ever built.
    .overrideProvider(getQueueToken('extract'))
    .useValue(queue)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  // Restated from main.ts, which installs it inside bootstrap() rather than in
  // AppModule, so no consumer of AppModule inherits it. These tests therefore
  // prove that THIS configuration behaves, not that main.ts is configured this
  // way; the two have to be kept in step by hand until it becomes an APP_PIPE.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Port 0: the dev API already owns :3000 and must keep it. 127.0.0.1 rather
  // than 0.0.0.0 keeps getUrl()'s ::1 ambiguity out of the base URL.
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const pipeline = app.get(PipelineService);

  let drained = 0;
  return {
    app,
    base,
    gateway,
    queue,
    pipeline,
    api: (apiKey: string) => new ApiClient(base, apiKey),
    async drainQueue() {
      const pending = queue.jobs.slice(drained);
      drained = queue.jobs.length;
      const results: { sheetId: string; error: Error | null }[] = [];
      for (const job of pending) {
        try {
          await pipeline.run(job.data.sheetId);
          results.push({ sheetId: job.data.sheetId, error: null });
        } catch (err) {
          results.push({ sheetId: job.data.sheetId, error: err as Error });
        }
      }
      return results;
    },
    async close() {
      // PrismaService disconnects itself in onModuleDestroy; the temp directory
      // has nobody to clean it up but this.
      await app.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

/**
 * A rule that forwards everything the filter is not obliged to hold back.
 *
 * A client with NO FilterRule rows gets no decisions at all -- `filter` loops
 * over an empty rule list and returns nothing -- so every extracted person lands
 * in the ledger with no assignment and the handout has nothing to meter. That is
 * a real state a client can be in, and review-and-rules.e2e.spec.ts covers it on
 * purpose; it is simply no use as the baseline for testing anything downstream
 * of the filter, so every client here starts with one rule.
 *
 * Deliberately permissive: empty presentsAs and empty countries both mean "any",
 * and minConfidence 'low' clears every entry in the recorded replies. The rules
 * are not what these tests are measuring -- what survives them is -- and a
 * narrow rule would make a routing change look like a pipeline regression. The
 * one thing it cannot wave through is an avatar/name disagreement, which
 * `filter` holds for review before it consults any rule at all.
 */
export async function forwardEverything(clientId: string): Promise<void> {
  await prisma.filterRule.create({
    data: {
      clientId,
      position: 0,
      enabled: true,
      presentsAs: [],
      countries: [],
      minConfidence: 'low',
      action: 'forward',
    },
  });
}
