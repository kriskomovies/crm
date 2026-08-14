/**
 * What a client that has never visited the settings screen actually gets.
 *
 * No other test can answer this. Every fixture pins the caps and the model
 * explicitly -- deliberately, because the suite claims 50 rows in a batch and
 * asserts a dollar figure keyed to one model, and the product defaults would
 * make those tests fail as a wrong count and a wrong price rather than as a
 * changed default. The consequence is that the defaults themselves are
 * exercised by nothing, and two of them have now been changed in ways that
 * alter behaviour on a live deployment:
 *
 *   sessionCapPerAccount   2000 (a value that cannot bind) -> 80 (one that
 *                          does, about three times a day at a 240 daily cap)
 *   extractionModel        gemini-3.6-flash -> the cheap one, which forwards 3
 *                          of the keyed 5 women where the other forwards 1
 *
 * Each moved in TWO places -- the Prisma schema and a hand-written migration --
 * and a change that lands in only one of them is invisible: Prisma omits the
 * column from the INSERT, so what a new client is created with is whatever the
 * database DEFAULT says, whatever the schema file claims. That disagreement is
 * what this file exists to catch, which is why the row is built with
 * prisma.client.create and not through makeClient.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { EXTRACTION_MODELS } from '../src/extraction/models';
import { dropFixtures, makeClient, prisma } from './fixtures';

afterEach(dropFixtures);
afterAll(async () => {
  await prisma.$disconnect();
});

/** Rows this file created directly, since they never went through makeClient. */
const bare: string[] = [];
afterEach(async () => {
  await prisma.client.deleteMany({ where: { id: { in: bare.splice(0) } } });
});

/**
 * A client row with nothing set but the two columns that have no default.
 *
 * Deliberately NOT makeClient: that helper pins every value this file is here
 * to read, so going through it would assert the fixtures against themselves.
 */
async function bareClient() {
  const tag = randomUUID();
  const row = await prisma.client.create({
    data: { name: `int defaults ${tag}`, apiKeyHash: `defaults-${tag}` },
  });
  bare.push(row.id);
  return row;
}

describe('the defaults a new client is created with', () => {
  it('meters 240 a day and 80 in a rolling hour', async () => {
    const client = await bareClient();
    expect(client.dailyCapPerAccount).toBe(240);
    // 80 is ON. It shipped at 2000 for one release -- the settings ceiling,
    // which cannot bind at any daily cap of 1000 or less -- so that adding the
    // column changed nothing for anyone. This value binds: a claim is truncated
    // while remainingToday is still healthy, which an agent build older than
    // remainingInWindow reads as "the CRM has nobody left for me" and acts on
    // irreversibly. Agents first, then this.
    expect(client.sessionCapPerAccount).toBe(80);
    expect(client.sessionWindowMinutes).toBe(60);
  });

  it('extracts with the cheap model, and it is one the server will run', async () => {
    const client = await bareClient();
    // The trade this default buys, measured on the keyed 99 at the geometry the
    // pipeline sends: 3 of 5 women forwarded to a men-only feed instead of 1,
    // for $0.0233 a sheet instead of $0.1282. Five is the whole gender sample.
    expect(client.extractionModel).toBe('gemini-3-flash-preview-nothinking');
    // A default outside the selectable set would be a client nobody could save
    // the settings screen for without changing the model first.
    expect(EXTRACTION_MODELS as readonly string[]).toContain(client.extractionModel);
  });

  it('is not what the fixtures hand out, which is the reason this file exists', async () => {
    const fixture = await makeClient();
    const row = await prisma.client.findUniqueOrThrow({ where: { id: fixture.id } });
    // If these ever agree, the fixtures have stopped pinning and the rest of
    // the suite has quietly become a test of the product defaults -- at which
    // point changing a default breaks unrelated files for unrelated reasons.
    expect(row.sessionCapPerAccount).toBe(2000);
    expect(row.extractionModel).toBe('gemini-3.6-flash');
  });
});
