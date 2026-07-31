/**
 * Wall-clock cost of the reads the operator UI makes on every load, measured
 * over the volume scripts/seed.ts produces (~20,000 people, ~17,000
 * assignments, 320 sheets across 12 personalities and 3 clients).
 *
 * This is a measurement, not a gate. It asserts only that the endpoints answer
 * correctly and prints what they cost, because a hard millisecond threshold on
 * a developer laptop fails for reasons that have nothing to do with the code.
 * A regression shows up as a number in the log, which is what a human can act
 * on; a red test that flaps is what a human learns to ignore.
 *
 * Skips itself when the API is not listening or the seed has not been run:
 *
 *   npx ts-node scripts/seed.ts --reset
 *   npx nest build && node dist/main.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from './fixtures';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000';
/**
 * The largest seeded client; its key is minted by scripts/seed.ts.
 *
 * Every figure here is one tenant's half of the estate -- the shape a real
 * dashboard load has. /api/stats used to be the exception, answering
 * unauthenticated with every client's numbers merged; it is now guarded and
 * scoped like the rest, so its cost is measured over this client alone.
 */
const SEED_CLIENT = 'seed northwind';
const SEED_API_KEY = 'seed-key-1';
/** Below this the numbers say nothing useful, so say so instead of reporting them. */
const MIN_PEOPLE = 5_000;

let apiUp = false;
let biggest: { id: string; name: string; people: number } | null = null;

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${SEED_API_KEY}` },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  // One warm-up so the figures are steady state rather than first-query plan
  // cost, then the best of three -- the median of a laptop is mostly noise.
  await run();
  let best = Infinity;
  let out!: T;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    out = await run();
    best = Math.min(best, performance.now() - t0);
  }
  console.log(`  ${label.padEnd(46)} ${best.toFixed(0).padStart(6)} ms`);
  return out;
}

beforeAll(async () => {
  try {
    await fetch(`${BASE}/api/personalities`);
    apiUp = true;
  } catch {
    apiUp = false;
  }

  const rows = await prisma.personality.findMany({
    where: { client: { name: SEED_CLIENT } },
    select: { id: true, name: true, _count: { select: { people: true } } },
  });
  const top = rows.sort((a, b) => b._count.people - a._count.people)[0];
  const total = rows.reduce((n, r) => n + r._count.people, 0);
  if (top && total >= MIN_PEOPLE) {
    biggest = { id: top.id, name: top.name, people: top._count.people };
    console.log(
      `\n"${SEED_CLIENT}": ${total} people across ${rows.length} personalities; ` +
        `largest is "${top.name}" with ${top._count.people}`,
    );
  }
});

afterAll(() => prisma.$disconnect());

describe('read path timings over seeded volume', () => {
  it('GET /api/stats', async (ctx) => {
    if (!apiUp || !biggest) ctx.skip();
    const body = await timed('GET /api/stats  (default 30d)', () => get('/api/stats'));
    expect(body.byDay.length).toBe(30);
    expect(body.totals.targets).toBeGreaterThan(0);
    expect(body.byPersonality.length).toBeGreaterThan(0);
  });

  it('GET /api/stats?personalityId=', async (ctx) => {
    if (!apiUp || !biggest) ctx.skip();
    const body = await timed('GET /api/stats  (one personality)', () =>
      get(`/api/stats?personalityId=${biggest!.id}`),
    );
    expect(body.byPersonality).toHaveLength(1);
  });

  it('GET /api/stats over the full 45-day seeded window', async (ctx) => {
    if (!apiUp || !biggest) ctx.skip();
    const to = new Date();
    const from = new Date(to.getTime() - 44 * 86_400_000);
    const body = await timed('GET /api/stats  (45 days)', () =>
      get(`/api/stats?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`),
    );
    expect(body.byDay.length).toBe(45);
  });

  it('GET /api/personalities', async (ctx) => {
    if (!apiUp || !biggest) ctx.skip();
    const body = await timed('GET /api/personalities', () => get('/api/personalities'));
    // The {items, nextCursor} envelope, like every other list endpoint. This
    // route is deliberately not paginated -- see PersonalitiesService.list --
    // so the cursor is always null, but the shape is the shared one and a
    // client must never have to special-case it.
    expect(Array.isArray(body)).toBe(false);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.nextCursor).toBeNull();
  });

  it('full cursor walk of the largest personality', async (ctx) => {
    if (!apiUp || !biggest) ctx.skip();

    for (const limit of [100, 500]) {
      let seen = 0;
      let pages = 0;
      let slowestPage = 0;
      const t0 = performance.now();
      let cursor: string | null = null;
      do {
        const p0 = performance.now();
        const body: { items: unknown[]; nextCursor: string | null } = await get(
          `/api/personalities/${biggest!.id}/targets?limit=${limit}` +
            (cursor ? `&cursor=${cursor}` : ''),
        );
        slowestPage = Math.max(slowestPage, performance.now() - p0);
        seen += body.items.length;
        pages++;
        cursor = body.nextCursor;
      } while (cursor && pages < 500);

      const total = performance.now() - t0;
      console.log(
        `  cursor walk limit=${String(limit).padEnd(3)} ` +
          `${String(pages).padStart(3)} pages, ${String(seen).padStart(5)} rows` +
          `${String(total.toFixed(0)).padStart(8)} ms total, ` +
          `${slowestPage.toFixed(0).padStart(4)} ms slowest page`,
      );
      // The point of a cursor: the last page must cost what the first did.
      expect(seen).toBe(biggest!.people);
    }
  });
});
