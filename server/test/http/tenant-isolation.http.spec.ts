/**
 * Two tenants, one key, and every route that takes an id.
 *
 * This is the highest-value file in the suite because the failure it looks for
 * has already happened here: /api/* shipped with no guard, /api/stats returned
 * the whole estate to anyone, and GET /api/sheets/:id/image minted a presigned
 * URL for any tenant's screenshot from the id alone. Those were fixed by scoping
 * every query to `req.client.id`. Scoping is a per-query decision, made anew in
 * every method, and the next one written is as likely to be forgotten as the
 * last one was.
 *
 * Two rules run through the assertions:
 *
 *   404 rather than 403, everywhere. The id IS the secret -- these are uuids the
 *   operator UI prints in URLs -- and 403 confirms that the id names something
 *   real, which is most of what an attacker wanted.
 *
 *   A 404 is not evidence that nothing happened. Every destructive route is
 *   asserted twice: the caller was refused, AND the victim's row is unchanged.
 *   A handler that deletes first and 404s afterwards passes the first assertion
 *   perfectly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { NO_NATIONALITY } from '../../src/extraction/normalize';
import {
  addPeopleByNationality,
  dropFixtures,
  makeClient,
  prisma,
  queueTargets,
  TestClient,
} from '../fixtures';
import { bootHarness, Harness } from './app';
import { addSheet } from './seed';

let api: Harness;

beforeAll(async () => {
  api = await bootHarness();
});
afterEach(dropFixtures);
afterAll(async () => {
  await api?.close();
  await prisma.$disconnect();
});

interface Tenant {
  client: TestClient;
  auth: string;
  personalityId: string;
  accountId: string;
  handles: string[];
  sheetIds: string[];
}

/**
 * A tenant with everything an isolation test might reach for: a personality, an
 * account, a queue with real assignments in it, and billed sheets.
 *
 * Given different sizes for A and B on purpose -- equal counts make a leak that
 * doubles a number indistinguishable from a leak that swaps it.
 */
async function tenant(people: number, sheets: number): Promise<Tenant> {
  const client = await makeClient();
  const personalityId = client.personality.id;
  const accountId = client.personality.accounts[0].id;
  const handles = await queueTargets(personalityId, accountId, people);
  const sheetIds: string[] = [];
  for (let i = 0; i < sheets; i++) {
    sheetIds.push((await addSheet(accountId, { usd: 0.02 })).id);
  }
  return { client, auth: `Bearer ${client.apiKey}`, personalityId, accountId, handles, sheetIds };
}

async function twoTenants(): Promise<{ a: Tenant; b: Tenant }> {
  // 3 vs 7 people and 1 vs 2 sheets: every number below is distinguishable from
  // every other, so a wrong total names which query leaked.
  return { a: await tenant(3, 1), b: await tenant(7, 2) };
}

describe('reads scoped to the calling client', () => {
  it('GET /api/personalities returns only the caller`s personalities', async () => {
    const { a, b } = await twoTenants();

    const res = await api.get('/api/personalities', { auth: a.auth });

    expect(res.status).toBe(200);
    expect(res.body.items.map((p: any) => p.id)).toEqual([a.personalityId]);
    // Not just "b is absent from the ids" -- absent from the whole document.
    // A nested field carrying b's account label would be just as much a leak.
    expect(res.text).not.toContain(b.personalityId);
    expect(res.text).not.toContain(b.client.personality.accounts[0].label);
  });

  it('GET /api/overview returns only the caller`s personalities and spend', async () => {
    const { a, b } = await twoTenants();

    const res = await api.get('/api/overview', { auth: a.auth });

    expect(res.status).toBe(200);
    expect(res.body.personalities.map((p: any) => p.id)).toEqual([a.personalityId]);
    expect(res.body.totals.sheets).toBe(1);
    expect(res.body.totals.byState.queued).toBe(3);
    expect(res.text).not.toContain(b.personalityId);
  });

  it('GET /api/sheets returns only the caller`s sheets', async () => {
    const { a, b } = await twoTenants();

    const res = await api.get('/api/sheets', { auth: a.auth });

    expect(res.status).toBe(200);
    expect(res.body.items.map((s: any) => s.id)).toEqual(a.sheetIds);
    for (const id of b.sheetIds) expect(res.text).not.toContain(id);
  });

  it('GET /api/personalities/:id/targets 404s on another tenant`s personality', async () => {
    const { a, b } = await twoTenants();

    const res = await api.get(`/api/personalities/${b.personalityId}/targets`, { auth: a.auth });

    expect(res.status).toBe(404);
    // The handles are the product. A 404 whose body still carried them would be
    // the same breach with a different status code.
    for (const handle of b.handles) expect(res.text).not.toContain(handle);
  });

  it('GET /v1/personalities/:id/ledger 404s on another tenant`s personality', async () => {
    const { a, b } = await twoTenants();

    const res = await api.get(`/v1/personalities/${b.personalityId}/ledger`, { auth: a.auth });

    expect(res.status).toBe(404);
    for (const handle of b.handles) expect(res.text).not.toContain(handle);
  });

  it('GET /api/sheets/:id/image 404s on another tenant`s sheet', async () => {
    const { a, b } = await twoTenants();

    const res = await api.get(`/api/sheets/${b.sheetIds[0]}/image`, { auth: a.auth });

    // The answer to this route is a URL that serves the image, so an id alone
    // must never be enough.
    expect(res.status).toBe(404);
    expect(res.body?.url).toBeUndefined();
  });

  it('GET /v1/accounts/:id/sheets/:jobId 404s on another tenant`s job', async () => {
    const { a, b } = await twoTenants();
    const res = await api.get(`/v1/accounts/${b.accountId}/sheets/${b.sheetIds[0]}`, {
      auth: a.auth,
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/rules names only the caller`s own nationalities', async () => {
    /**
     * A NEW leak surface. This route used to answer with a constant, so there
     * was nothing here to scope and nothing here to get wrong; it now reads
     * `people` through `personalities` and aggregates them, which is exactly
     * the shape of query /api/stats shipped unscoped and served the whole
     * estate's country mix from.
     *
     * Distinct values per tenant, not distinct counts: a wrong scope shows up
     * as a value that cannot have come from the caller's ledger, which is
     * unambiguous in a way a doubled number is not.
     */
    const { a, b } = await twoTenants();
    await addPeopleByNationality(a.personalityId, [{ nationality: 'welsh', count: 2 }]);
    await addPeopleByNationality(b.personalityId, [{ nationality: 'lithuanian', count: 5 }]);

    const res = await api.get('/api/rules', { auth: a.auth });

    expect(res.status).toBe(200);
    const origins: { value: string; count: number }[] = res.body.options.origins;
    expect(origins).toContainEqual({ value: 'welsh', count: 2 });
    expect(origins.map((o) => o.value)).not.toContain('lithuanian');
    // And the null bucket is counted per tenant too. `a` has 3 people from
    // queueTargets with no nationality plus 2 welsh; `b`'s 7 are not here.
    expect(origins).toContainEqual({ value: NO_NATIONALITY, count: 3 });
  });
});

describe('writes scoped to the calling client', () => {
  it('POST /api/personalities/:id/targets 404s and writes nothing', async () => {
    const { a, b } = await twoTenants();

    const res = await api.post(`/api/personalities/${b.personalityId}/targets`, {
      auth: a.auth,
      body: { handles: ['plantedbya'] },
    });

    expect(res.status).toBe(404);
    // Both directions: not smuggled into b's ledger, and not quietly redirected
    // into a's either.
    expect(
      await prisma.person.count({
        where: { handle: 'plantedbya', personalityId: { in: [a.personalityId, b.personalityId] } },
      }),
    ).toBe(0);
  });

  it('POST /api/personalities/:id/accounts 404s and creates no account', async () => {
    const { a, b } = await twoTenants();

    const res = await api.post(`/api/personalities/${b.personalityId}/accounts`, {
      auth: a.auth,
      body: { label: 'planted_by_a' },
    });

    expect(res.status).toBe(404);
    expect(await prisma.account.count({ where: { personalityId: b.personalityId } })).toBe(1);
  });

  it('DELETE /api/personalities/:id 404s and leaves the personality standing', async () => {
    const { a, b } = await twoTenants();

    const res = await api.delete(`/api/personalities/${b.personalityId}`, { auth: a.auth });

    expect(res.status).toBe(404);
    // The assertion that matters. A delete-then-check handler answers 404 too,
    // and cascades away every handle the personality ever claimed on its way
    // there -- unrecoverable, and invisible from the response.
    expect(
      await prisma.personality.findUnique({ where: { id: b.personalityId } }),
    ).not.toBeNull();
    expect(await prisma.person.count({ where: { personalityId: b.personalityId } })).toBe(7);
  });

  it('PATCH /api/accounts/:id 404s and leaves the account running', async () => {
    const { a, b } = await twoTenants();

    const res = await api.patch(`/api/accounts/${b.accountId}`, {
      auth: a.auth,
      body: { enabled: false },
    });

    expect(res.status).toBe(404);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: b.accountId } });
    // Disabling another tenant's account stops their work silently.
    expect(account.enabled).toBe(true);
  });

  it('POST /api/accounts/:id/reset-daily-cap 404s and leaves their ledger alone', async () => {
    const { a, b } = await twoTenants();
    // b is already carrying seven queued rows; three of them go out to b's own
    // machine, so there is in-flight work for a to damage.
    await api.get(`/v1/accounts/${b.accountId}/targets?limit=3`, { auth: b.auth });

    const res = await api.post(`/api/accounts/${b.accountId}/reset-daily-cap`, { auth: a.auth });

    expect(res.status).toBe(404);
    // The route rewrites assignment rows, so an unscoped version does not merely
    // leak -- it requeues another tenant's in-flight work and hands them a fresh
    // cap on accounts they are already running.
    expect(
      await prisma.assignment.count({
        where: { accountId: b.accountId, state: 'handed_out', handedOutAt: { not: null } },
      }),
    ).toBe(3);
  });

  it('PUT /api/settings cannot reach another tenant, only the caller', async () => {
    const { a, b } = await twoTenants();

    // There is no id in the path -- the client comes from the key -- so the
    // isolation to prove is that raising the caller's cap does not move anyone
    // else's. Another tenant's cap is a rate-limit ban on their Snapchat
    // accounts, and this is now one write that could reach every account they
    // own at once.
    const res = await api.request('PUT', '/api/settings', {
      auth: a.auth,
      body: { dailyCapPerAccount: 2000, followPaceSeconds: 0 },
    });

    expect(res.status).toBe(200);
    const theirs = await prisma.client.findUniqueOrThrow({ where: { id: b.client.id } });
    expect(theirs.dailyCapPerAccount).toBe(50);
    expect(theirs.followPaceSeconds).toBe(2);
  });

  it('GET /v1/accounts/:id/targets 404s and claims nothing', async () => {
    const { a, b } = await twoTenants();

    const res = await api.get(`/v1/accounts/${b.accountId}/targets?limit=25`, { auth: a.auth });

    expect(res.status).toBe(404);
    expect(res.body?.targets).toBeUndefined();
    // This route is a CLAIM: reaching the service would have flipped rows to
    // handed_out and spent b's daily cap, and the rows would not come back.
    expect(
      await prisma.assignment.count({ where: { accountId: b.accountId, state: 'queued' } }),
    ).toBe(7);
    expect(
      await prisma.assignment.count({ where: { accountId: b.accountId, handedOutAt: { not: null } } }),
    ).toBe(0);
  });

  it('POST /v1/accounts/:id/targets/:handle/result 404s and leaves the ledger alone', async () => {
    const { a, b } = await twoTenants();

    const res = await api.post(`/v1/accounts/${b.accountId}/targets/${b.handles[0]}/result`, {
      auth: a.auth,
      body: { result: 'followed', note: 'written by the wrong tenant' },
    });

    expect(res.status).toBe(404);
    const person = await prisma.person.findFirstOrThrow({
      where: { personalityId: b.personalityId, handle: b.handles[0] },
      include: { assignment: true },
    });
    expect(person.assignment?.state).toBe('queued');
    expect(person.assignment?.note).toBeNull();
  });
});

describe('the cursor as a cross-tenant probe', () => {
  /**
   * DEFECT, pinned, and the only place in this file where something does cross
   * the tenant line.
   *
   * No row of b's is returned -- the WHERE clause still scopes to a. But Prisma
   * resolves a cursor by looking the row up BY ID ALONE, outside the filter, so
   * the answer differs depending on whether the uuid names a Person row
   * anywhere in the database:
   *
   *   cursor names a real person (any tenant)  -> a's own rows, from that id on
   *   cursor names nothing                     -> an empty page
   *
   * Which makes any authenticated key an existence oracle for Person ids across
   * the whole estate, one request per guess. A uuid is not guessable, so this is
   * a confirmation tool rather than an enumeration -- but the ids in question
   * are printed in operator UI URLs and pasted into tickets, and "is this id
   * still live" is exactly what a leaked one is worth confirming.
   *
   * The second half is a bug in its own right: an unrecognised cursor silently
   * returns an arbitrary suffix of the caller's list instead of an error.
   */
  it('WRONG: a cursor id belonging to another tenant steers the caller`s own page', async () => {
    const { a, b } = await twoTenants();

    // Explicit low ids, so the comparison is deterministic rather than
    // depending on where a random uuid v4 happens to sort.
    const present = '00000000-0000-4000-8000-00000000000b';
    const absent = '00000000-0000-4000-8000-00000000000c';
    await prisma.person.create({
      data: { id: present, personalityId: b.personalityId, handle: 'bsecret', displayName: 'B' },
    });

    const withPresent = await api.get(
      `/api/personalities/${a.personalityId}/targets?cursor=${present}`,
      { auth: a.auth },
    );
    const withAbsent = await api.get(
      `/api/personalities/${a.personalityId}/targets?cursor=${absent}`,
      { auth: a.auth },
    );

    // The distinguishable pair IS the finding.
    expect(withPresent.status).toBe(200);
    expect(withPresent.body.items.length).toBeGreaterThan(0);
    expect(withAbsent.status).toBe(200);
    expect(withAbsent.body.items).toEqual([]);

    // What comes back is still only a's. The disclosure is the existence of the
    // id, not the row it names.
    for (const item of withPresent.body.items) expect(a.handles).toContain(item.handle);
    expect(withPresent.text).not.toContain('bsecret');
  });
});

describe('/api/stats', () => {
  it('404s on another tenant`s personality filter', async () => {
    const { a, b } = await twoTenants();
    const res = await api.get(`/api/stats?personalityId=${b.personalityId}`, { auth: a.auth });
    expect(res.status).toBe(404);
  });

  it('counts only the caller`s estate, and the two tenants partition the data', async () => {
    const { a, b } = await twoTenants();

    const statsA = await api.get('/api/stats', { auth: a.auth });
    const statsB = await api.get('/api/stats', { auth: b.auth });
    expect(statsA.status).toBe(200);
    expect(statsB.status).toBe(200);

    /**
     * Compared against Postgres restricted to these two tenants, not against a
     * bare COUNT(*) of the tables. The dev cluster holds other clients' rows and
     * always will, so "A + B == every row in the database" would be a test of
     * how recently someone truncated it. Restricting the comparison to the two
     * ids keeps the property that actually matters: the two answers neither
     * overlap nor lose anything between them.
     */
    const ids = [a.personalityId, b.personalityId];
    const accountIds = [a.accountId, b.accountId];
    const dbPeople = await prisma.person.count({ where: { personalityId: { in: ids } } });
    const dbSheets = await prisma.sheet.count({ where: { accountId: { in: accountIds } } });
    const dbQueued = await prisma.assignment.count({
      where: { accountId: { in: accountIds }, state: 'queued' },
    });

    expect(statsA.body.totals.targets).toBe(3);
    expect(statsB.body.totals.targets).toBe(7);
    expect(statsA.body.totals.targets + statsB.body.totals.targets).toBe(dbPeople);

    expect(statsA.body.totals.sheets).toBe(1);
    expect(statsB.body.totals.sheets).toBe(2);
    expect(statsA.body.totals.sheets + statsB.body.totals.sheets).toBe(dbSheets);

    expect(statsA.body.totals.queued + statsB.body.totals.queued).toBe(dbQueued);

    // Decimal(10,6) in the database, summed as floats here, so compare at the
    // precision the column actually stores.
    expect(statsA.body.totals.usd).toBeCloseTo(0.02, 6);
    expect(statsB.body.totals.usd).toBeCloseTo(0.04, 6);

    expect(statsA.body.byPersonality.map((p: any) => p.id)).toEqual([a.personalityId]);
    expect(statsA.body.byAccount.map((r: any) => r.id)).toEqual([a.accountId]);
    // Catch-all: no id, name or label belonging to b may appear anywhere in a's
    // document, including inside byCountry, byModel or byDay.
    expect(statsA.text).not.toContain(b.personalityId);
    expect(statsA.text).not.toContain(b.accountId);
    expect(statsA.text).not.toContain(b.client.personality.name);
  });

  it('treats an empty personalityId as unfiltered rather than as a missing personality', async () => {
    const { a } = await twoTenants();
    // The documented URL shape is ?personalityId=&from=&to=, so a UI that has
    // no filter selected sends the key with nothing after it.
    const res = await api.get('/api/stats?personalityId=&from=&to=', { auth: a.auth });
    expect(res.status).toBe(200);
    expect(res.body.totals.targets).toBe(3);
  });
});
