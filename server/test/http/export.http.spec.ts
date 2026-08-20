/**
 * GET /api/personalities/:id/targets.txt -- the one route in the product that
 * answers with a file rather than JSON.
 *
 * It was `.csv`, and this file went on testing `.csv` long after the route
 * stopped existing: the export was deliberately changed to one handle per line,
 * because eight columns is the right shape for a spreadsheet and the wrong one
 * for feeding handles back into a machine, which is what this export is for.
 * Twelve tests here were asserting against 404s. Two of them PASSED while doing
 * it -- both expected a 404, and got one because nothing was served at all.
 *
 * Three things are asserted, and only the first has changed with the format.
 *
 * The format, end to end. One handle per line and nothing else: no header, no
 * quoting, and above all no BOM, which would arrive as an invisible character on
 * the front of the first handle and make that one handle match nobody. The CSV
 * escaping tests are gone with the CSV -- src/common/csv.spec.ts still proves
 * the formatter -- and what replaces them is the stronger claim this format
 * allows: a display name cannot reach the file at all.
 *
 * The tenant line. Every other read in the estate is scoped through clientId and
 * this one has to be too, doubly so: it is not a page of the ledger, it is the
 * whole ledger in one response, and the ledger is real people's handles. /api/*
 * shipped once with no guard at all, so the scoping is checked on the route
 * rather than assumed from the neighbours.
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

/** The handles in the file. Lines, plainly -- there is nothing to parse, which
 *  is the point of the format. The trailing newline leaves a final empty entry. */
function handles(txt: string): string[] {
  return txt.split('\n').filter((line) => line.length > 0);
}

describe('the file itself', () => {
  it('answers as a text attachment named after the personality and the filter', async () => {
    const c = await ctx();
    await addFollowed(c, 'plainone', 'Plain One');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.txt?state=followed`, {
      auth: c.auth,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    // The filter is in the filename because these files are the unit of exchange
    // between two systems: a folder of them all called "kris.txt" is unusable.
    expect(disposition).toContain('-followed.txt');
  });

  it('writes one handle per line, with no header and no BOM', async () => {
    const c = await ctx();
    await addFollowed(c, 'firsthandle', 'First Handle');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.txt`, {
      auth: c.auth,
    });

    // The BOM is the one that matters. It is invisible, it survives a copy and
    // paste, and it would make the FIRST handle of every file -- and only the
    // first -- match nobody on import.
    expect(res.text.startsWith('﻿')).toBe(false);
    expect(res.text).toBe('firsthandle\n');
  });

  it('honours ?state=, so the followed list exports only the followed', async () => {
    const c = await ctx();
    await addFollowed(c, 'didfollow', 'Did Follow');
    await queueTargets(c.personalityId, c.accountId, 1, 'stillqueued');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.txt?state=followed`, {
      auth: c.auth,
    });

    expect(handles(res.text)).toEqual(['didfollow']);
  });

  it('writes nothing at all when nothing matches', async () => {
    const c = await ctx();

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.txt?state=followed`, {
      auth: c.auth,
    });

    expect(res.status).toBe(200);
    // Empty, and not a lone header line: the import reads every line as a
    // handle, so a file with one line in it is a file with one bad handle in it.
    expect(res.text).toBe('');
  });

  it('exports every row, not the first page of them', async () => {
    const c = await ctx();
    const queued = await queueTargets(c.personalityId, c.accountId, 120, 'walked');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.txt`, {
      auth: c.auth,
    });

    const written = handles(res.text);
    expect(written).toHaveLength(120);
    expect(new Set(written).size).toBe(120);
    expect([...written].sort()).toEqual([...queued].sort());
  });
});

describe('a display name cannot reach the file', () => {
  /**
   * What replaced the CSV escaping tests, and a stronger claim than they made.
   *
   * A display name arrives from a vision model reading a stranger's profile: it
   * is attacker-influenced text. The CSV carried it and had to escape it
   * correctly every single time; this format never carries it, so the whole
   * class of "opens cleanly in Excel and is silently wrong" is gone rather than
   * handled.
   */
  it('carries the handle and none of the name, however hostile the name is', async () => {
    const c = await ctx();
    await addFollowed(c, 'hostileone', "=cmd|'/c calc'!A1");
    await addFollowed(c, 'hostiletwo', 'Smith, "JJ"\nSecond Line');
    await addFollowed(c, 'hostilethree', 'Zoë 🌸');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.txt`, {
      auth: c.auth,
    });

    expect(handles(res.text).sort()).toEqual(['hostileone', 'hostilethree', 'hostiletwo']);
    for (const fragment of ['cmd', 'calc', 'Smith', 'Second Line', 'Zoë', '🌸']) {
      expect(res.text).not.toContain(fragment);
    }
    // And the newline inside that second name did not become a record boundary,
    // which is the failure the CSV version of this test existed to catch.
    expect(handles(res.text)).toHaveLength(3);
  });
});

describe('the tenant line', () => {
  it('404s on another tenant`s personality and writes no rows', async () => {
    const a = await ctx();
    const b = await ctx();
    const secret = await queueTargets(b.personalityId, b.accountId, 4, 'bsecret');

    const res = await api.get(`/api/personalities/${b.personalityId}/targets.txt`, {
      auth: a.auth,
    });

    expect(res.status).toBe(404);
    // A 404 whose body still carried the handles would be the same breach with
    // a different status code -- and this route's body is the whole ledger.
    for (const handle of secret) expect(res.text).not.toContain(handle);
    expect(res.headers.get('content-type')).not.toContain('text/plain');
  });

  it('exports only the caller`s own rows when both tenants hold the same handle', async () => {
    const a = await ctx();
    const b = await ctx();
    // The same handle under two clients is two unrelated Snapchat accounts, and
    // both ledgers may legitimately hold it -- so identical handles are the case
    // where a missing clientId scope is hardest to see. Which is why this one
    // checks the COUNT: the handle itself cannot tell the two apart.
    await addFollowed(a, 'shared_handle', 'Belongs To A');
    await addFollowed(b, 'shared_handle', 'Belongs To B');

    const res = await api.get(`/api/personalities/${a.personalityId}/targets.txt`, {
      auth: a.auth,
    });

    expect(handles(res.text)).toEqual(['shared_handle']);
  });
});

describe('refusals arrive before the first byte', () => {
  it('rejects an unknown state as JSON, not as a truncated file', async () => {
    const c = await ctx();

    const res = await api.get(`/api/personalities/${c.personalityId}/targets.txt?state=folowed`, {
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
      '/api/personalities/00000000-0000-4000-8000-0000000000ff/targets.txt',
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
