import { defineConfig } from 'vitest/config';

import { decoratorMetadata } from './test/http/decorator-metadata';

/**
 * Two suites, kept apart on purpose.
 *
 *   npx vitest run --project unit   pure functions, no I/O, under a second
 *   npx vitest run --project int    real Postgres on 127.0.0.1:5433
 *   npx vitest run --project e2e    real HTTP into the real AppModule
 *   npx vitest run                  all three
 *
 * The integration project is not "the unit tests but slower". It covers the
 * three things no test double can answer honestly: that
 * UNIQUE (personalityId, handle) is scoped per personality, that the
 * FOR UPDATE SKIP LOCKED handout holds under concurrent claims, and that a
 * cursor walk over a real index is exhaustive. Anything a mock could prove
 * belongs in the unit project, so the fast loop stays fast.
 *
 * The e2e project is a third thing again: it boots AppModule, listens on an
 * ephemeral port and talks to it over HTTP, so the guard, the pipes, multipart
 * upload, the controllers and PipelineService are all exercised together. The
 * int project calls services directly and never touches any of that. Only the
 * VLM call is stubbed -- with recorded replies, see test/recorded.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.int.spec.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'int',
          include: ['test/**/*.int.spec.ts'],
          environment: 'node',
          setupFiles: ['test/setup.ts'],
          // The claim tests race requests against one account deliberately.
          // Letting unrelated files interleave on the same dev cluster proves
          // nothing extra and makes a real failure hard to tell from noise.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        // esbuild cannot emit `design:paramtypes`, so Nest's injector refuses to
        // build a single controller under the default transform. See
        // test/http/decorator-metadata.ts -- it is scoped to this project so the
        // unit suite keeps esbuild's speed.
        plugins: [decoratorMetadata()],
        test: {
          // The HTTP contract: guards, the global pipe, the DTOs, the route
          // table and tenant isolation. Kept apart from `int` because it needs a
          // booted AppModule listening on a socket, which the service-level
          // suite deliberately does not, and because a red run here means
          // something quite different -- `int` failing says the ledger is wrong,
          // `http` failing says the door is open.
          //
          // The suffix is .http.spec.ts, not .int.spec.ts, so the int project's
          // glob does not also collect these files and run them twice.
          name: 'http',
          include: ['test/http/**/*.http.spec.ts'],
          environment: 'node',
          setupFiles: ['test/setup.ts'],
          // Each file boots its own server and each test builds its own client,
          // but they share one dev cluster with `int`. Serial keeps a failure
          // readable.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Same reason as the http project: Nest's injector needs
        // `design:paramtypes`, and esbuild does not emit it. Shared rather than
        // copied -- two divergent copies of a compiler shim is worse than one
        // dependency between sibling test projects.
        plugins: [decoratorMetadata()],
        test: {
          // The journey: a real screenshot uploaded over multipart, extracted by
          // the real pipeline from a RECORDED model reply, folded into the real
          // ledger, handed back out under the real cap. `http` proves the door
          // is locked and `int` proves the ledger is consistent; neither runs
          // PipelineService at all, and that is what this project is for.
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.spec.ts'],
          environment: 'node',
          setupFiles: ['test/setup.ts'],
          // One dev cluster, shared with `int` and `http`. Serial keeps a
          // failure attributable to the test that caused it.
          fileParallelism: false,
          // A 99-entry sheet is ~200 rows of ledger writes per upload and the
          // journey test does five uploads.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
