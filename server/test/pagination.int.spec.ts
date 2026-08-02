/**
 * Cursor pagination over a personality's target list and its ledger.
 *
 * The contract is `{ items, nextCursor }` walked on a stable unique column,
 * never OFFSET. What a real database is needed to prove is that the walk is
 * exhaustive and non-repeating: an off-by-one in the `skip: 1` that follows a
 * cursor silently drops one row per page, which against a 30-row dev database
 * looks like nothing at all and against a 20,000-row ledger loses hundreds of
 * people the client paid to have found.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { slicePage } from '../src/common/pagination';
import {
  addPeople,
  addPeopleAtOneInstant,
  addPersonality,
  dropFixtures,
  makeClient,
  personalities,
  prisma,
  targets,
} from './fixtures';

afterEach(dropFixtures);
afterAll(() => prisma.$disconnect());

interface Walk {
  handles: string[];
  pageSizes: number[];
}

/** Walk every page, with a hard stop so a non-terminating cursor fails fast. */
async function walk(
  page: (cursor?: string) => Promise<{ items: { handle: string }[]; nextCursor: string | null }>,
): Promise<Walk> {
  const handles: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 200; n++) {
    const res = await page(cursor);
    pageSizes.push(res.items.length);
    for (const item of res.items) handles.push(item.handle);
    if (res.nextCursor === null) return { handles, pageSizes };
    cursor = res.nextCursor;
  }
  throw new Error('cursor walk did not terminate within 200 pages');
}

describe('cursor pagination over targets', () => {
  it('returns every row exactly once across a multi-page walk', async () => {
    const client = await makeClient();
    const expected = await addPeople(client.personality.id, 450);

    const { handles, pageSizes } = await walk((cursor) =>
      personalities.targets(client.id, client.personality.id, 100, undefined, undefined, cursor),
    );

    expect(handles).toHaveLength(450);
    expect(new Set(handles).size).toBe(450);
    expect([...handles].sort()).toEqual([...expected].sort());
    expect(pageSizes).toEqual([100, 100, 100, 100, 50]);
  });

  it('terminates cleanly when the row count is an exact multiple of the limit', async () => {
    const client = await makeClient();
    await addPeople(client.personality.id, 200);

    const { handles, pageSizes } = await walk((cursor) =>
      personalities.targets(client.id, client.personality.id, 100, undefined, undefined, cursor),
    );

    // The extra row fetched to detect a further page must not become a third,
    // empty page -- a UI that renders "page 3 of 3, no results" is a bug report.
    expect(pageSizes).toEqual([100, 100]);
    expect(handles).toHaveLength(200);
  });

  it('caps the page at 500 however large a limit is asked for', async () => {
    const client = await makeClient();
    await addPeople(client.personality.id, 520);

    const page = await personalities.targets(client.id, client.personality.id, 10_000);

    expect(page.items).toHaveLength(500);
    expect(page.nextCursor).not.toBeNull();
  });

  it('is scoped to one personality even when handles are shared', async () => {
    const client = await makeClient();
    const kris = client.personality;
    const mia = await addPersonality(client.id);
    await addPeople(kris.id, 120, 'shared');
    await addPeople(mia.id, 300, 'shared');

    const krisWalk = await walk((cursor) =>
      personalities.targets(client.id, kris.id, 50, undefined, undefined, cursor),
    );
    const miaWalk = await walk((cursor) =>
      personalities.targets(client.id, mia.id, 50, undefined, undefined, cursor),
    );

    expect(krisWalk.handles).toHaveLength(120);
    expect(miaWalk.handles).toHaveLength(300);
    // Identical handle strings, different ledgers: neither walk may leak into
    // the other however much the two overlap.
    expect(new Set(krisWalk.handles).size).toBe(120);
    expect(await prisma.person.count({ where: { personalityId: kris.id } })).toBe(120);
  });

  it('rejects an unknown personality', async () => {
    const client = await makeClient();
    await expect(
      personalities.targets(client.id, 'no-such-personality', 100),
    ).rejects.toThrow();
  });
});

describe('cursor pagination over the ledger', () => {
  /**
   * `targets` above orders by id, which is unique, so it can never tie. The
   * ledger orders by [createdAt desc, id desc], and a whole sheet's people are
   * written in one createMany and therefore share a createdAt exactly. This is
   * the walk where the tiebreak is the only thing between the cursor and a page
   * boundary that repeats or skips.
   */
  it('walks rows that all share one createdAt without repeating or skipping', async () => {
    const client = await makeClient();
    const expected = await addPeopleAtOneInstant(client.personality.id, 250);

    const { handles, pageSizes } = await walk(async (cursor) => {
      const rows = await targets.ledger(client.personality.id, 101, cursor);
      return slicePage(rows, 100);
    });

    // The primary sort key ties across every row, so this only holds if the
    // cursor comparison falls through to id.
    expect(pageSizes).toEqual([100, 100, 50]);
    expect(new Set(handles).size).toBe(250);
    expect([...handles].sort()).toEqual([...expected].sort());
  });
});
