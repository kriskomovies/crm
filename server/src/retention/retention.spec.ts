/**
 * Retention decides whether the disk fills, and it is the one part of the
 * pipeline whose bug is invisible until a volume is full. These run against
 * fakes rather than Postgres because what is being asserted is the policy --
 * which sheets are chosen, and when -- not the storage engine.
 */
import { SheetStatus } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { RetentionService } from './retention.service';

interface Row {
  id: string;
  storageKey: string | null;
  status: SheetStatus;
  receivedAt: Date;
}

const NOW = new Date('2026-08-01T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function fakes(rows: Row[]) {
  const removed: string[] = [];
  const storage = {
    remove: async (key: string) => {
      removed.push(key);
    },
  };
  const prisma = {
    sheet: {
      findMany: async ({ where, take, skip, orderBy }: any) => {
        const cutoff = where.receivedAt?.lt as Date | undefined;
        const hit = rows.filter(
          (r) =>
            r.storageKey !== null &&
            where.status.in.includes(r.status) &&
            (cutoff === undefined || r.receivedAt < cutoff),
        );
        hit.sort((a, b) =>
          orderBy?.receivedAt === 'desc'
            ? b.receivedAt.getTime() - a.receivedAt.getTime()
            : a.receivedAt.getTime() - b.receivedAt.getTime(),
        );
        const from = skip ?? 0;
        return hit
          .slice(from, from + take)
          .map((r) => ({ id: r.id, storageKey: r.storageKey }));
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        row.storageKey = data.storageKey;
        return row;
      },
    },
  };
  return { prisma, storage, removed, rows };
}

/** Env is read in field initialisers, so it must be set before construction. */
function build(rows: Row[], env: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const f = fakes(rows);
  const svc = new RetentionService(f.prisma as any, f.storage as any);
  process.env = saved;
  return { svc, ...f };
}

describe('retention: deleting on completion', () => {
  let rows: Row[];

  beforeEach(() => {
    rows = [
      { id: 's1', storageKey: 'k1', status: SheetStatus.extracted, receivedAt: NOW },
    ];
  });

  it('deletes the image the moment the pipeline commits, by default', async () => {
    const { svc, removed } = build(rows, { SHEET_RETENTION_DAYS: '0' });
    await svc.onPipelineComplete('s1', 'k1');
    expect(removed).toEqual(['k1']);
    // Nulled, so "pruned" is a fact the row states rather than a 404 a caller
    // has to infer.
    expect(rows[0].storageKey).toBeNull();
  });

  it('keeps the image when a window is configured', async () => {
    const { svc, removed } = build(rows, { SHEET_RETENTION_DAYS: '14' });
    await svc.onPipelineComplete('s1', 'k1');
    expect(removed).toEqual([]);
    expect(rows[0].storageKey).toBe('k1');
  });

  it('never throws when storage is broken: the vision call already succeeded', async () => {
    const { svc } = build(rows, { SHEET_RETENTION_DAYS: '0' });
    (svc as any).storage = {
      remove: async () => {
        throw new Error('bucket unreachable');
      },
    };
    await expect(svc.onPipelineComplete('s1', 'k1')).resolves.toBeUndefined();
    // Pointer left intact so the sweep can retry. A null pointer to a live
    // object is unrecoverable -- nothing could ever find it again.
    expect(rows[0].storageKey).toBe('k1');
  });
});

describe('retention: the sweep', () => {
  it('with days=0 takes every completed sheet regardless of age', async () => {
    const rows: Row[] = [
      { id: 'a', storageKey: 'ka', status: SheetStatus.extracted, receivedAt: NOW },
      { id: 'b', storageKey: 'kb', status: SheetStatus.partial, receivedAt: daysAgo(30) },
    ];
    const { svc, removed } = build(rows, { SHEET_RETENTION_DAYS: '0' });
    const r = await svc.sweep(NOW);
    expect(removed.sort()).toEqual(['ka', 'kb']);
    expect(r.deleted).toBe(2);
  });

  it('with days=14 leaves anything inside the window alone', async () => {
    const rows: Row[] = [
      { id: 'young', storageKey: 'ky', status: SheetStatus.extracted, receivedAt: daysAgo(3) },
      { id: 'old', storageKey: 'ko', status: SheetStatus.extracted, receivedAt: daysAgo(20) },
    ];
    const { svc, removed } = build(rows, { SHEET_RETENTION_DAYS: '14' });
    await svc.sweep(NOW);
    expect(removed).toEqual(['ko']);
  });

  it('keeps the newest N failures and drops the rest, by count not age', async () => {
    const rows: Row[] = [
      { id: 'ok', storageKey: 'kok', status: SheetStatus.extracted, receivedAt: NOW },
      { id: 'f1', storageKey: 'k1', status: SheetStatus.failed, receivedAt: daysAgo(1) },
      { id: 'f2', storageKey: 'k2', status: SheetStatus.rejected, receivedAt: daysAgo(2) },
      { id: 'f3', storageKey: 'k3', status: SheetStatus.failed, receivedAt: daysAgo(3) },
      { id: 'f4', storageKey: 'k4', status: SheetStatus.failed, receivedAt: daysAgo(4) },
    ];
    const { svc, removed } = build(rows, {
      SHEET_RETENTION_DAYS: '0',
      SHEET_FAILED_KEEP_MAX: '2',
    });
    await svc.sweep(NOW);
    // The success goes on completion. Of four failures the newest two keep
    // their evidence; the older two lose it. Age never enters into it -- the
    // one-day-old failure survives and the four-day-old does not because of
    // where they sit in the order, which is what bounds the disk when a
    // gateway outage fails every sheet for a day.
    expect(removed.sort()).toEqual(['k3', 'k4', 'kok']);
    expect(rows.find((r) => r.id === 'f1')!.storageKey).toBe('k1');
    expect(rows.find((r) => r.id === 'f2')!.storageKey).toBe('k2');
  });

  it('a failure burst cannot exceed the cap however many arrive', async () => {
    const rows: Row[] = Array.from({ length: 50 }, (_, i) => ({
      id: `f${i}`,
      storageKey: `k${i}`,
      status: SheetStatus.failed,
      receivedAt: daysAgo(i),
    }));
    const { svc } = build(rows, {
      SHEET_RETENTION_DAYS: '0',
      SHEET_FAILED_KEEP_MAX: '10',
    });
    await svc.sweep(NOW);
    expect(rows.filter((r) => r.storageKey !== null)).toHaveLength(10);
  });

  it('never touches a sheet still in flight', async () => {
    const rows: Row[] = [
      { id: 'r', storageKey: 'kr', status: SheetStatus.received, receivedAt: daysAgo(99) },
      { id: 'x', storageKey: 'kx', status: SheetStatus.extracting, receivedAt: daysAgo(99) },
    ];
    const { svc, removed } = build(rows, { SHEET_RETENTION_DAYS: '0' });
    await svc.sweep(NOW);
    // A queued job is about to ask for these bytes; deleting them would turn a
    // retry into a permanent failure.
    expect(removed).toEqual([]);
  });

  it('with days<0 keeps every successful image forever', async () => {
    const rows: Row[] = [
      { id: 'a', storageKey: 'ka', status: SheetStatus.extracted, receivedAt: daysAgo(999) },
    ];
    const { svc, removed } = build(rows, {
      SHEET_RETENTION_DAYS: '-1',
      SHEET_FAILED_KEEP_MAX: '-1',
    });
    await svc.sweep(NOW);
    expect(removed).toEqual([]);
  });
});

describe('retention: purge before a cascade', () => {
  it('deletes the named objects and ignores already-pruned rows', async () => {
    const { svc, removed } = build([], { SHEET_RETENTION_DAYS: '0' });
    const gone = await svc.purgeKeys(['k1', null, 'k2']);
    expect(removed).toEqual(['k1', 'k2']);
    expect(gone).toBe(2);
  });
});
