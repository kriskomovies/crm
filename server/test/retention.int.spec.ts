/**
 * Retention against the real database and a real filesystem.
 *
 * src/retention/retention.spec.ts already covers the POLICY -- which sheets are
 * chosen and when -- against fakes, and that is the right place for it. Four
 * things it cannot answer, because in each of them the answer belongs to
 * Postgres or to the disk rather than to the service:
 *
 *   1. `storageKey` is nullable NOW. The whole feature depends on migration
 *      20260801210000 having widened a NOT NULL column, and a fake `update`
 *      that assigns null to a JavaScript object will happily "pass" against a
 *      database that would reject the same write. So the column is checked in
 *      the catalog, and the null is written and read back out of the table.
 *
 *   2. The sweep's `where` is a Prisma query, not the fake's `Array.filter`.
 *      `status: { in: [...] }` reaching Postgres as the six-value enum, and
 *      `receivedAt: { lt: cutoff }` reaching it as a timestamp comparison, are
 *      properties of the generated SQL.
 *
 *   3. The failed cap is `orderBy receivedAt desc` + `skip` + `take`. The fake
 *      sorts and slices an array; the real thing asks the planner for rows
 *      N+1..N+500 of an ordering, which is where an off-by-one or a missing
 *      `desc` actually lives.
 *
 *   4. Purge-before-cascade is a race against ON DELETE CASCADE. The objects
 *      have to go while the rows that name them still exist; a fake with no
 *      cascade cannot fail this test.
 *
 * STORAGE. The local driver into a per-run temp directory, so `remove` really
 * unlinks and `existsSync` really answers. Deliberately NOT server/.storage:
 * the dev API on :3000 is pointed there, and this file deletes things.
 * test/fixtures.ts builds its own StorageService and PersonalitiesService from
 * the ambient env -- which is `.storage` -- so the cascade test constructs its
 * own rather than importing that one. Everything else about those objects is
 * identical; only the root differs.
 *
 * WHY THE SWEEP TESTS ROLL BACK. `sweep()` is global by design: it selects
 * every sheet in the cluster with a pointer and a terminal status, because that
 * is what "the disk stays flat" means. The dev cluster this suite runs against
 * is not empty -- it carries a few hundred seeded sheets whose images are in
 * server/.storage -- and an honest sweep would null every one of those
 * pointers. That is not a mess that cleans up: the service's own comment says
 * it, a null pointer to a live object is unrecoverable, because nothing is left
 * that knows the object's name. So each sweep runs inside an interactive
 * transaction that always rolls back, and the first statement in that
 * transaction nulls every OTHER account's pointer -- inside the transaction,
 * so it is undone on the way out -- which both keeps foreign keys away from
 * `remove()` entirely and makes the assertions exact rather than
 * "n of them plus whatever else was lying around".
 *
 * The rollback covers the rows only. The unlinks are real and are not undone,
 * which is the half being asserted on.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Prisma, SheetStatus } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { GatewayClient } from '../src/extraction/gateway.client';
import { PersonalitiesService } from '../src/personalities/personalities.service';
import { PipelineService } from '../src/pipeline/pipeline.service';
import { RetentionService } from '../src/retention/retention.service';
import { StorageService } from '../src/storage/storage.service';

import { addPersonality, dropFixtures, makeClient, prisma, queueTargets } from './fixtures';

type Db = Prisma.TransactionClient | typeof prisma;

/** Both services read env in field initialisers, so it must be set before `new`. */
function withEnv<T>(env: Record<string, string>, make: () => T): T {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return make();
  } finally {
    process.env = saved;
  }
}

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'snap-retention-int-'));

const storage = withEnv(
  { STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: STORAGE_DIR },
  () => new StorageService(),
);

/** Defaults restated rather than inherited: .env must not decide what is tested. */
function retentionFor(db: Db, env: Record<string, string> = {}): RetentionService {
  return withEnv(
    { SHEET_RETENTION_DAYS: '0', SHEET_FAILED_KEEP_MAX: '20', ...env },
    () => new RetentionService(db as any, storage),
  );
}

const onDisk = (key: string): boolean => existsSync(join(STORAGE_DIR, key));

interface Seeded {
  id: string;
  key: string;
  status: SheetStatus;
  receivedAt: Date;
}

/**
 * A sheet row and the object it points at, both real.
 *
 * The bytes matter: every assertion in this file about deletion is
 * `existsSync` on a file that was genuinely written first, so "deleted" cannot
 * be confused with "was never there".
 */
async function seedSheet(
  clientId: string,
  accountId: string,
  status: SheetStatus,
  receivedAt: Date = new Date(),
): Promise<Seeded> {
  const sha256 = randomBytes(32).toString('hex');
  const key = storage.key(clientId, sha256);
  await storage.put(key, Buffer.from(`pretend sheet ${sha256}`));
  const row = await prisma.sheet.create({
    data: { accountId, sha256, storageKey: key, status, receivedAt },
    select: { id: true },
  });
  return { id: row.id, key, status, receivedAt };
}

interface SweptRow {
  id: string;
  status: SheetStatus;
  storageKey: string | null;
  receivedAt: Date;
}

const ROLLBACK = 'RetentionIntRollback';

/**
 * Run one sweep against Postgres and give back what it did, without keeping any
 * of the row changes. See the header for why this is not simply `svc.sweep()`.
 */
async function sweptInRollback(
  accountId: string,
  env: Record<string, string>,
  passes = 1,
): Promise<{ results: { deleted: number; failed: number }[]; rows: SweptRow[] }> {
  let captured: { results: { deleted: number; failed: number }[]; rows: SweptRow[] } | null = null;
  try {
    await prisma.$transaction(
      async (tx) => {
        // Every other sheet in the cluster becomes invisible to the sweep, so
        // no key belonging to anyone else is ever handed to storage.remove()
        // and the counts below are about this test's rows and nothing else.
        await tx.sheet.updateMany({
          where: { accountId: { not: accountId }, storageKey: { not: null } },
          data: { storageKey: null },
        });

        const svc = retentionFor(tx, env);
        // Annotated rather than inferred: `[]` inside this callback widens to
        // never[] and the push below stops compiling. It never showed up
        // because test/ was outside the type-checking project until the session
        // cap landed and put it back in.
        const results: { deleted: number; failed: number }[] = [];
        for (let i = 0; i < passes; i++) results.push(await svc.sweep());

        captured = {
          results,
          rows: await tx.sheet.findMany({
            where: { accountId },
            select: { id: true, status: true, storageKey: true, receivedAt: true },
            orderBy: { receivedAt: 'desc' },
          }),
        };
        const stop = new Error('rolling back the sweep');
        stop.name = ROLLBACK;
        throw stop;
      },
      // The quarantine touches every sheet in the cluster and the sweep then
      // issues one UPDATE per pruned row; the 5s default is not enough.
      { maxWait: 30_000, timeout: 60_000 },
    );
  } catch (err) {
    if ((err as Error).name !== ROLLBACK) throw err;
  }
  return captured!;
}

/** Assertions read better as `key(rows, id)` than as a findIndex in every line. */
const keyOf = (rows: SweptRow[], id: string): string | null =>
  rows.find((r) => r.id === id)!.storageKey;

afterEach(dropFixtures);
afterAll(async () => {
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe('storageKey is nullable in the database', () => {
  it('has actually had the NOT NULL dropped on this cluster', async () => {
    // The catalog, not the schema file. A migration that exists in git and was
    // never applied to the database everything else in this suite runs against
    // is precisely the failure this feature can have.
    const cols = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'sheets' AND column_name = 'storageKey'
    `;
    expect(cols).toHaveLength(1);
    expect(cols[0].is_nullable).toBe('YES');
  });

  it('accepts a sheet written with no pointer at all', async () => {
    const client = await makeClient();
    const row = await prisma.sheet.create({
      data: {
        accountId: client.personality.accounts[0].id,
        sha256: randomBytes(32).toString('hex'),
        storageKey: null,
        status: SheetStatus.extracted,
      },
    });
    expect(row.storageKey).toBeNull();
    expect(
      (await prisma.sheet.findUniqueOrThrow({ where: { id: row.id } })).storageKey,
    ).toBeNull();
  });

  it('persists the null the pipeline hook writes, and keeps the row', async () => {
    const client = await makeClient();
    const sheet = await seedSheet(
      client.id,
      client.personality.accounts[0].id,
      SheetStatus.extracted,
    );
    // The billing row that outlives the image: /api/stats is built from it.
    await prisma.extraction.create({
      data: {
        sheetId: sheet.id,
        model: 'gemini-3.6-flash',
        promptTokens: 1_000,
        completionTokens: 500,
        usd: 0.0074,
        seconds: 12.5,
        rawReply: { profiles: [{ handle: 'kept_verbatim' }] },
        profilesFound: 1,
        distinctCuesRatio: 0.9,
      },
    });
    expect(onDisk(sheet.key)).toBe(true);

    await retentionFor(prisma, { SHEET_RETENTION_DAYS: '0' }).onPipelineComplete(
      sheet.id,
      sheet.key,
    );

    // Read past Prisma: this is the column in the table, not the value the
    // update statement echoed back.
    const raw = await prisma.$queryRaw<{ storageKey: string | null }[]>`
      SELECT "storageKey" FROM sheets WHERE id = ${sheet.id}
    `;
    expect(raw).toHaveLength(1);
    expect(raw[0].storageKey).toBeNull();
    expect(onDisk(sheet.key)).toBe(false);

    // Only the pixels went. The row and its history are the reason the column
    // was widened instead of the row being deleted.
    const kept = await prisma.sheet.findUniqueOrThrow({
      where: { id: sheet.id },
      include: { extraction: true },
    });
    expect(kept.status).toBe(SheetStatus.extracted);
    expect(kept.receivedAt).toEqual(sheet.receivedAt);
    expect(Number(kept.extraction!.usd)).toBeCloseTo(0.0074, 6);
    expect(kept.extraction!.rawReply).toEqual({ profiles: [{ handle: 'kept_verbatim' }] });
  });

  it('keeps a pruned sheet s (accountId, sha256) claim, so a re-upload is still free', async () => {
    const client = await makeClient();
    const account = client.personality.accounts[0];
    const sheet = await seedSheet(client.id, account.id, SheetStatus.extracted);
    const { sha256 } = await prisma.sheet.findUniqueOrThrow({
      where: { id: sheet.id },
      select: { sha256: true },
    });

    await retentionFor(prisma).onPipelineComplete(sheet.id, sheet.key);

    // The unique index is on the row, not on the object, so it survives the
    // pruning -- which is the whole argument for keeping the row.
    await expect(
      prisma.sheet.create({
        data: { accountId: account.id, sha256, storageKey: 'a/second/copy.png' },
      }),
    ).rejects.toThrow();
  });

  it('leaves both the pointer and the object alone when a window is configured', async () => {
    const client = await makeClient();
    const sheet = await seedSheet(
      client.id,
      client.personality.accounts[0].id,
      SheetStatus.extracted,
    );

    await retentionFor(prisma, { SHEET_RETENTION_DAYS: '14' }).onPipelineComplete(
      sheet.id,
      sheet.key,
    );

    expect(onDisk(sheet.key)).toBe(true);
    expect(
      (await prisma.sheet.findUniqueOrThrow({ where: { id: sheet.id } })).storageKey,
    ).toBe(sheet.key);
  });
});

describe('the sweep selects the right rows in Postgres', () => {
  it('takes the terminal successes and never a sheet still in flight', async () => {
    const client = await makeClient();
    const account = client.personality.accounts[0];
    const sheets: Record<string, Seeded> = {};
    for (const status of [
      SheetStatus.received,
      SheetStatus.extracting,
      SheetStatus.extracted,
      SheetStatus.partial,
      SheetStatus.failed,
      SheetStatus.rejected,
    ]) {
      sheets[status] = await seedSheet(client.id, account.id, status);
    }

    // Failures held entirely, so this measures the success prune alone.
    const { results, rows } = await sweptInRollback(account.id, {
      SHEET_RETENTION_DAYS: '0',
      SHEET_FAILED_KEEP_MAX: '-1',
    });

    expect(results[0]).toEqual({ deleted: 2, failed: 0 });
    expect(keyOf(rows, sheets.extracted.id)).toBeNull();
    expect(keyOf(rows, sheets.partial.id)).toBeNull();
    expect(onDisk(sheets.extracted.key)).toBe(false);
    expect(onDisk(sheets.partial.key)).toBe(false);

    // `received` and `extracting` are not terminal: a queued job is about to
    // ask for those bytes, and deleting them turns a retry into a permanent
    // failure. This is the assertion the enum has to be reaching Postgres for.
    for (const status of [SheetStatus.received, SheetStatus.extracting]) {
      expect(keyOf(rows, sheets[status].id)).toBe(sheets[status].key);
      expect(onDisk(sheets[status].key)).toBe(true);
    }
    // And the failures are untouched with the cap disabled.
    for (const status of [SheetStatus.failed, SheetStatus.rejected]) {
      expect(keyOf(rows, sheets[status].id)).toBe(sheets[status].key);
      expect(onDisk(sheets[status].key)).toBe(true);
    }
  });

  it('still never takes an in-flight sheet when both prunes are wide open', async () => {
    const client = await makeClient();
    const account = client.personality.accounts[0];
    const sheets: Record<string, Seeded> = {};
    for (const status of [
      SheetStatus.received,
      SheetStatus.extracting,
      SheetStatus.extracted,
      SheetStatus.partial,
      SheetStatus.failed,
      SheetStatus.rejected,
    ]) {
      // Ancient, so nothing is spared by age either.
      sheets[status] = await seedSheet(
        client.id,
        account.id,
        status,
        new Date(Date.now() - 400 * 86_400_000),
      );
    }

    const { results, rows } = await sweptInRollback(account.id, {
      SHEET_RETENTION_DAYS: '0',
      SHEET_FAILED_KEEP_MAX: '0',
    });

    expect(results[0].deleted).toBe(4);
    for (const status of [
      SheetStatus.extracted,
      SheetStatus.partial,
      SheetStatus.failed,
      SheetStatus.rejected,
    ]) {
      expect(keyOf(rows, sheets[status].id)).toBeNull();
      expect(onDisk(sheets[status].key)).toBe(false);
    }
    for (const status of [SheetStatus.received, SheetStatus.extracting]) {
      expect(keyOf(rows, sheets[status].id)).toBe(sheets[status].key);
      expect(onDisk(sheets[status].key)).toBe(true);
    }
  });

  it('compares receivedAt against the cutoff in the database, not in the process', async () => {
    const client = await makeClient();
    const account = client.personality.accounts[0];
    const at = (days: number) => new Date(Date.now() - days * 86_400_000);

    const young = await seedSheet(client.id, account.id, SheetStatus.extracted, at(3));
    const inside = await seedSheet(client.id, account.id, SheetStatus.partial, at(13));
    const old = await seedSheet(client.id, account.id, SheetStatus.extracted, at(20));
    // Older than everything and still not eligible: age never overrides status.
    const inFlight = await seedSheet(client.id, account.id, SheetStatus.received, at(99));

    const { results, rows } = await sweptInRollback(account.id, {
      SHEET_RETENTION_DAYS: '14',
      SHEET_FAILED_KEEP_MAX: '-1',
    });

    expect(results[0]).toEqual({ deleted: 1, failed: 0 });
    expect(keyOf(rows, old.id)).toBeNull();
    expect(onDisk(old.key)).toBe(false);
    for (const kept of [young, inside, inFlight]) {
      expect(keyOf(rows, kept.id)).toBe(kept.key);
      expect(onDisk(kept.key)).toBe(true);
    }
  });
});

describe('the failed cap, against real rows and a real ORDER BY', () => {
  /**
   * Twelve failures, cap of four.
   *
   * Written in a jumbled order on purpose: `receivedAt` descending and
   * insertion order disagree, so a sweep that skipped the wrong four -- or
   * ordered ascending, or skipped none -- keeps a different set than this
   * asserts, rather than accidentally the right one.
   */
  it('keeps exactly the newest N and drops every older one', async () => {
    const client = await makeClient();
    const account = client.personality.accounts[0];
    const CAP = 4;
    const base = Date.now();

    const byAge: Seeded[] = new Array(12);
    for (const rank of [7, 0, 11, 4, 2, 9, 1, 6, 10, 3, 8, 5]) {
      byAge[rank] = await seedSheet(
        client.id,
        account.id,
        // Both terminal-failure statuses share one pool: the cap is over
        // "failures", not over each status separately.
        rank % 2 === 0 ? SheetStatus.failed : SheetStatus.rejected,
        new Date(base - rank * 60_000),
      );
    }

    const { results, rows } = await sweptInRollback(account.id, {
      SHEET_RETENTION_DAYS: '0',
      SHEET_FAILED_KEEP_MAX: String(CAP),
    });

    expect(results[0]).toEqual({ deleted: byAge.length - CAP, failed: 0 });

    const survivors = rows.filter((r) => r.storageKey !== null).map((r) => r.id);
    expect(survivors.sort()).toEqual(byAge.slice(0, CAP).map((s) => s.id).sort());

    for (const [rank, sheet] of byAge.entries()) {
      const kept = rank < CAP;
      expect({ rank, key: keyOf(rows, sheet.id) }).toEqual({
        rank,
        key: kept ? sheet.key : null,
      });
      expect({ rank, onDisk: onDisk(sheet.key) }).toEqual({ rank, onDisk: kept });
    }
  });

  it('bounds a burst however large it is, and a second pass finds nothing left', async () => {
    const client = await makeClient();
    const account = client.personality.accounts[0];
    const CAP = 5;
    const base = Date.now();

    // The gateway-outage shape: everything fails at once, all the same way.
    const byAge: Seeded[] = [];
    for (let rank = 0; rank < 30; rank++) {
      byAge.push(
        await seedSheet(
          client.id,
          account.id,
          SheetStatus.failed,
          new Date(base - rank * 1_000),
        ),
      );
    }

    const { results, rows } = await sweptInRollback(
      account.id,
      { SHEET_RETENTION_DAYS: '0', SHEET_FAILED_KEEP_MAX: String(CAP) },
      2,
    );

    expect(results[0]).toEqual({ deleted: 25, failed: 0 });
    // Idempotent: nulling the pointer removes the row from the sweep's own
    // filter, so `skip` still lands on the same survivors next time round.
    expect(results[1]).toEqual({ deleted: 0, failed: 0 });
    expect(rows.filter((r) => r.storageKey !== null)).toHaveLength(CAP);
    expect(byAge.slice(0, CAP).every((s) => onDisk(s.key))).toBe(true);
    expect(byAge.slice(CAP).some((s) => onDisk(s.key))).toBe(false);
  });
});

describe('purge before a personality cascade', () => {
  /**
   * PersonalitiesService, PipelineService and RetentionService built here rather
   * than imported from ./fixtures for one reason: the fixture module's
   * StorageService resolves STORAGE_LOCAL_DIR from the ambient env, which is
   * server/.storage -- the directory the dev API is serving out of. These are
   * the same classes wired the same way, pointed at the temp directory.
   */
  function personalitiesOnTempStorage(): PersonalitiesService {
    const retention = retentionFor(prisma);
    const pipeline = new PipelineService(
      prisma as any,
      storage,
      new GatewayClient(),
      retention,
    );
    return new PersonalitiesService(prisma as any, pipeline, retention);
  }

  it('removes the objects and lets the cascade take the rows that named them', async () => {
    const client = await makeClient({ accounts: 2 });
    const kris = client.personality;
    const mia = await addPersonality(client.id, { accounts: 1 });

    const doomed = [
      await seedSheet(client.id, kris.accounts[0].id, SheetStatus.extracted),
      await seedSheet(client.id, kris.accounts[1].id, SheetStatus.failed),
      // In flight, and it goes anyway: nothing will be able to read it once the
      // row naming it is gone, so "still needed" is no longer a reason to keep
      // it. This is not the sweep.
      await seedSheet(client.id, kris.accounts[0].id, SheetStatus.received),
    ];
    // Already pruned by retention. purgeKeys must step over the null rather
    // than counting it or throwing on it.
    const alreadyPruned = await prisma.sheet.create({
      data: {
        accountId: kris.accounts[0].id,
        sha256: randomBytes(32).toString('hex'),
        storageKey: null,
        status: SheetStatus.extracted,
      },
      select: { id: true },
    });
    // A different personality of the SAME client: its image must survive, since
    // the cascade never reaches it.
    const survivor = await seedSheet(client.id, mia.accounts[0].id, SheetStatus.extracted);

    await queueTargets(kris.id, kris.accounts[0].id, 3);
    expect(
      await prisma.assignment.count({ where: { accountId: kris.accounts[0].id } }),
    ).toBe(3);
    expect(doomed.every((s) => onDisk(s.key))).toBe(true);

    await personalitiesOnTempStorage().remove(client.id, kris.id);

    // The objects are gone from the disk...
    for (const s of doomed) expect(onDisk(s.key)).toBe(false);
    // ...and so are the rows, all the way down.
    const ids = [...doomed.map((s) => s.id), alreadyPruned.id];
    expect(await prisma.sheet.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await prisma.personality.count({ where: { id: kris.id } })).toBe(0);
    expect(await prisma.account.count({ where: { personalityId: kris.id } })).toBe(0);
    expect(await prisma.person.count({ where: { personalityId: kris.id } })).toBe(0);
    expect(
      await prisma.assignment.count({
        where: { accountId: { in: kris.accounts.map((a) => a.id) } },
      }),
    ).toBe(0);

    // Scoped: the client, the sibling personality and its image are all intact.
    expect(await prisma.client.count({ where: { id: client.id } })).toBe(1);
    expect(await prisma.personality.count({ where: { id: mia.id } })).toBe(1);
    expect(await prisma.sheet.count({ where: { id: survivor.id } })).toBe(1);
    expect(onDisk(survivor.key)).toBe(true);
  });

  it('purges only what the caller names, and reports how many objects went', async () => {
    const client = await makeClient();
    const account = client.personality.accounts[0];
    const named = await seedSheet(client.id, account.id, SheetStatus.extracted);
    const unnamed = await seedSheet(client.id, account.id, SheetStatus.extracted);

    const gone = await retentionFor(prisma).purgeKeys([named.key, null]);

    expect(gone).toBe(1);
    expect(onDisk(named.key)).toBe(false);
    expect(onDisk(unnamed.key)).toBe(true);
    // purgeKeys deletes objects only. The rows are the cascade's business, and
    // both are still here because no cascade ran.
    expect(await prisma.sheet.count({ where: { accountId: account.id } })).toBe(2);
  });
});
