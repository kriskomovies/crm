/**
 * The response shapes, asserted from outside.
 *
 * One envelope, `{ items, nextCursor }`, on every list endpoint -- including the
 * ones that are not paginated and never will be. A client that special-cases the
 * endpoint returning a bare array is a client that breaks the day that endpoint
 * grows a page, and a permanently null cursor already says "there is no next
 * page". So the rule is checked on all of them, empty and non-empty, rather than
 * on the ones that happen to page today.
 *
 * And one deliberate exception, checked just as hard: GET
 * /v1/accounts/:id/targets is not a list. It is a metered claim -- calling it
 * SPENDS today's cap and mutates rows -- and it answers `{ targets,
 * remainingToday, ... }`. Anyone tidying that into the envelope would be
 * turning a side-effecting claim into something that reads like a page of data,
 * and the budget fields, which exist so a client can back off instead of
 * hot-polling an exhausted cap, would go with it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  addPeople,
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

interface Ctx {
  client: TestClient;
  auth: string;
  personalityId: string;
  accountId: string;
}

async function ctx(opts: { sessionCap?: number } = {}): Promise<Ctx> {
  const client = await makeClient(opts);
  return {
    client,
    auth: `Bearer ${client.apiKey}`,
    personalityId: client.personality.id,
    accountId: client.personality.accounts[0].id,
  };
}

function expectEnvelope(res: { status: number; body: any }) {
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(false);
  // Exactly two keys. An extra `total` or `page` would be a second, competing
  // pagination contract that clients would start depending on.
  expect(Object.keys(res.body).sort()).toEqual(['items', 'nextCursor']);
  expect(Array.isArray(res.body.items)).toBe(true);
  expect(res.body.nextCursor === null || typeof res.body.nextCursor === 'string').toBe(true);
}

describe('every list endpoint answers in the {items, nextCursor} envelope', () => {
  it('GET /api/personalities, populated and with a permanently null cursor', async () => {
    const c = await ctx();
    const res = await api.get('/api/personalities', { auth: c.auth });
    expectEnvelope(res);
    expect(res.body.items).toHaveLength(1);
    // Not paginated by design -- bounded by how many personalities one client
    // runs, and the UI needs all of them to fill its filter dropdown.
    expect(res.body.nextCursor).toBeNull();
  });

  it('GET /api/personalities/:id/targets', async () => {
    const c = await ctx();
    await addPeople(c.personalityId, 3);
    const res = await api.get(`/api/personalities/${c.personalityId}/targets`, { auth: c.auth });
    expectEnvelope(res);
    expect(res.body.items).toHaveLength(3);
  });

  it('GET /api/sheets', async () => {
    const c = await ctx();
    await addSheet(c.accountId);
    const res = await api.get('/api/sheets', { auth: c.auth });
    expectEnvelope(res);
    expect(res.body.items).toHaveLength(1);
  });

  it('GET /v1/personalities/:id/ledger', async () => {
    const c = await ctx();
    await addPeople(c.personalityId, 3);
    const res = await api.get(`/v1/personalities/${c.personalityId}/ledger`, { auth: c.auth });
    expectEnvelope(res);
    expect(res.body.items).toHaveLength(3);
  });

  /**
   * The empty case separately, because it is the one that tempts an
   * implementation into returning `[]`. A client that unwraps `.items` gets
   * `undefined` and iterating it throws -- on the request that returned no data,
   * which is the request nobody tests by hand.
   */
  it.each([
    ['GET /api/personalities', (c: Ctx) => '/api/personalities'],
    ['GET /api/personalities/:id/targets', (c: Ctx) => `/api/personalities/${c.personalityId}/targets`],
    ['GET /api/sheets', () => '/api/sheets'],
    ['GET /v1/personalities/:id/ledger', (c: Ctx) => `/v1/personalities/${c.personalityId}/ledger`],
  ])('%s keeps the envelope when there is nothing to return', async (_label, url) => {
    const c = await ctx();
    const res = await api.get(url(c), { auth: c.auth });
    expectEnvelope(res);
    if (url(c) !== '/api/personalities') expect(res.body.items).toEqual([]);
  });

  it('sets nextCursor to a string only when another page exists', async () => {
    const c = await ctx();
    await addPeople(c.personalityId, 12);

    const first = await api.get(`/api/personalities/${c.personalityId}/targets?limit=10`, {
      auth: c.auth,
    });
    expect(typeof first.body.nextCursor).toBe('string');
    expect(first.body.items).toHaveLength(10);

    const second = await api.get(
      `/api/personalities/${c.personalityId}/targets?limit=10&cursor=${first.body.nextCursor}`,
      { auth: c.auth },
    );
    expect(second.body.items).toHaveLength(2);
    // The last page ends the walk rather than handing back a cursor that would
    // fetch an empty third page.
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('GET /v1/accounts/:id/targets is a claim, not a list', () => {
  it('answers the claim shape and nothing else', async () => {
    const c = await ctx();
    await queueTargets(c.personalityId, c.accountId, 3);

    const res = await api.get(`/v1/accounts/${c.accountId}/targets?limit=2`, { auth: c.auth });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'paceSeconds',
      'refusedHandles',
      'remainingInWindow',
      'remainingToday',
      'sessionWindowMinutes',
      'targets',
    ]);
    // Explicitly NOT the envelope. Pinned so that a sweep to "make every
    // endpoint consistent" fails here instead of quietly dropping
    // remainingToday, which is the only reason a capped client knows to stop
    // polling.
    expect(res.body.items).toBeUndefined();
    expect(res.body.nextCursor).toBeUndefined();
    expect(res.body.targets).toHaveLength(2);
    expect(typeof res.body.remainingToday).toBe('number');
    // The second budget. A short batch used to mean "the queue is dry" once
    // remainingToday was healthy, and an agent hides people from its Quick Add
    // roster on that reading; with a session cap able to truncate a batch too,
    // both budgets have to be on the wire or that reading is wrong and the
    // damage is permanent.
    expect(typeof res.body.remainingInWindow).toBe('number');
    // Served so a client that finds the window full can sleep for a share of it
    // rather than hot-poll a metered write until it rolls.
    expect(typeof res.body.sessionWindowMinutes).toBe('number');
    expect(Array.isArray(res.body.refusedHandles)).toBe(true);
    // Delivered with the batch it applies to, so a machine cannot pace on a
    // number older than the work in front of it.
    expect(typeof res.body.paceSeconds).toBe('number');
  });

  it('reports each target with the fields an emulator needs', async () => {
    const c = await ctx();
    await queueTargets(c.personalityId, c.accountId, 1);
    const res = await api.get(`/v1/accounts/${c.accountId}/targets`, { auth: c.auth });
    expect(Object.keys(res.body.targets[0]).sort()).toEqual([
      'displayName',
      'handle',
      'nationality',
      'reason',
    ]);
  });

  it('spends the cap: remainingToday falls and a second call cannot re-take the same rows', async () => {
    const c = await ctx();
    const handles = await queueTargets(c.personalityId, c.accountId, 6);

    const first = await api.get(`/v1/accounts/${c.accountId}/targets?limit=4`, { auth: c.auth });
    const second = await api.get(`/v1/accounts/${c.accountId}/targets?limit=4`, { auth: c.auth });

    expect(first.body.remainingToday).toBe(46);
    expect(second.body.remainingToday).toBe(44);
    const taken = [...first.body.targets, ...second.body.targets].map((t: any) => t.handle);
    expect(taken).toHaveLength(6);
    expect(new Set(taken).size).toBe(6);
    expect([...taken].sort()).toEqual([...handles].sort());
  });

  it('returns an empty claim rather than an error when the queue is dry', async () => {
    const c = await ctx();
    const res = await api.get(`/v1/accounts/${c.accountId}/targets`, { auth: c.auth });
    expect(res.status).toBe(200);
    expect(res.body.targets).toEqual([]);
    expect(res.body.remainingToday).toBe(50);
    // Both budgets untouched, which is what makes this "no work exists" rather
    // than "you have spent something". Either one at zero would be a different
    // answer to the same empty list.
    expect(res.body.remainingInWindow).toBe(2000);
  });

  it('states the window is what stopped a short batch, not the queue', async () => {
    const c = await ctx({ sessionCap: 2 });
    await queueTargets(c.personalityId, c.accountId, 6);

    const res = await api.get(`/v1/accounts/${c.accountId}/targets?limit=5`, { auth: c.auth });

    expect(res.body.targets).toHaveLength(2);
    // Asked for five, got two, and 48 still to come today. Before the session
    // cap that combination could only mean the queue had run out, and the four
    // rows left behind would have been read as people nobody was going to add.
    expect(res.body.remainingToday).toBe(48);
    expect(res.body.remainingInWindow).toBe(0);
    expect(res.body.sessionWindowMinutes).toBe(60);
  });
});

describe('the non-list endpoints', () => {
  it('GET /api/overview returns personalities and totals, not an envelope', async () => {
    const c = await ctx();
    await queueTargets(c.personalityId, c.accountId, 2);
    await addSheet(c.accountId, { usd: 0.03 });

    const res = await api.get('/api/overview', { auth: c.auth });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['personalities', 'totals']);
    expect(Object.keys(res.body.totals).sort()).toEqual([
      'byState',
      'completionTokens',
      'promptTokens',
      'sheets',
      'usd',
    ]);
    // Prisma hands Decimal back and JSON.stringify turns that into a string,
    // which every arithmetic consumer reads as NaN.
    expect(typeof res.body.totals.usd).toBe('number');
    expect(res.body.totals.usd).toBeCloseTo(0.03, 6);
  });

  it('GET /api/stats returns the dashboard blocks', async () => {
    const c = await ctx();
    const res = await api.get('/api/stats', { auth: c.auth });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'byAccount',
      'byCountry',
      'byDay',
      'byModel',
      'byPersonality',
      'bySource',
      'range',
      'totals',
    ]);
    expect(typeof res.body.totals.usd).toBe('number');
    // A quiet day arrives as a row of zeroes rather than as a gap, so the chart
    // cannot draw a trend that never happened.
    expect(res.body.byDay).toHaveLength(30);
    expect(res.body.byDay[0]).toMatchObject({ sheets: 0, targets: 0, followed: 0, usd: 0 });
  });

  it('GET /api/rules serves origins as {value, count} and the rest as bare strings', async () => {
    /**
     * The only option list on this endpoint whose entries are objects, and the
     * asymmetry is the contract: presentsAs, confidences and skinTones are
     * closed vocabularies this server owns, while origins are read out of the
     * client's own ledger and carry the count that makes them worth ticking.
     *
     * Untested anywhere until now, which is how the shape could drift from what
     * the web reads without a red run. Pinned here rather than in a validation
     * test because the failure it catches is a rendered `[object Object]`, not
     * a rejected save.
     */
    const c = await ctx();
    await addPeopleByNationality(c.personalityId, [
      { nationality: 'welsh', count: 2 },
      { nationality: null, count: 1 },
    ]);

    const res = await api.get('/api/rules', { auth: c.auth });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['options', 'rule']);
    expect(Object.keys(res.body.options).sort()).toEqual([
      'confidences',
      'origins',
      'presentsAs',
      'skinTones',
    ]);
    for (const o of res.body.options.origins) {
      expect(Object.keys(o).sort()).toEqual(['count', 'value']);
      expect(typeof o.value).toBe('string');
      expect(typeof o.count).toBe('number');
    }
    expect(res.body.options.origins).toContainEqual({ value: 'welsh', count: 2 });
    expect(res.body.options.presentsAs).toEqual(['man', 'woman', 'ambiguous']);
    expect(res.body.options.confidences.every((v: unknown) => typeof v === 'string')).toBe(true);
  });

  it('GET /v1/accounts/:id/sheets/:jobId reports cost as a number', async () => {
    const c = await ctx();
    const sheet = await addSheet(c.accountId, { usd: 0.0125, profilesFound: 17 });

    const res = await api.get(`/v1/accounts/${c.accountId}/sheets/${sheet.id}`, { auth: c.auth });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'costUsd',
      'error',
      'jobId',
      'newPeople',
      'profilesFound',
      'queued',
      'status',
    ]);
    // This field was a string once a sheet had been extracted and the number 0
    // before that, so a client doing arithmetic on it got NaN exactly when
    // there was finally something to add up.
    expect(typeof res.body.costUsd).toBe('number');
    expect(res.body.costUsd).toBeCloseTo(0.0125, 6);
    expect(res.body.profilesFound).toBe(17);
  });

  it('GET /api/sheets reports per-row cost as a number', async () => {
    const c = await ctx();
    await addSheet(c.accountId, { usd: 0.0125 });
    const res = await api.get('/api/sheets', { auth: c.auth });
    expect(typeof res.body.items[0].usd).toBe('number');
    expect(res.body.items[0].usd).toBeCloseTo(0.0125, 6);
  });

  it('POST /api/personalities returns the created row', async () => {
    const c = await ctx();
    const res = await api.post('/api/personalities', { auth: c.auth, body: { name: 'mia' } });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['accounts', 'clientId', 'id', 'name']);
    expect(res.body.clientId).toBe(c.client.id);
  });

  it('POST /api/personalities/:id/targets reports added, duplicate, invalid and queued', async () => {
    const c = await ctx();

    const first = await api.post(`/api/personalities/${c.personalityId}/targets`, {
      auth: c.auth,
      body: { handles: ['realhandle', '!!', 'realhandle'] },
    });
    expect(first.status).toBe(201);
    expect(Object.keys(first.body).sort()).toEqual(['added', 'duplicate', 'invalid', 'queued']);
    // The same handle twice in one request is redundant, not an error.
    expect(first.body.added).toEqual(['realhandle']);
    expect(first.body.invalid).toEqual(['!!']);
    expect(first.body.queued).toBe(1);

    const again = await api.post(`/api/personalities/${c.personalityId}/targets`, {
      auth: c.auth,
      body: { handles: ['realhandle'] },
    });
    expect(again.body.added).toEqual([]);
    expect(again.body.duplicate).toEqual(['realhandle']);
    expect(again.body.queued).toBe(0);
  });

  it('PATCH /api/accounts/:id returns the account, not the whole personality', async () => {
    const c = await ctx();
    const res = await api.patch(`/api/accounts/${c.accountId}`, {
      auth: c.auth,
      body: { enabled: false },
    });
    expect(res.status).toBe(200);
    // dailyCap is still in the shape and still describes this account -- it is
    // the client's setting, reported rather than stored here.
    expect(Object.keys(res.body).sort()).toEqual(['dailyCap', 'enabled', 'id', 'label']);
    expect(res.body).toMatchObject({ dailyCap: 50, enabled: false });
  });

  it('POST /api/accounts/:id/reset-daily-cap reports what it freed, with a 200', async () => {
    const c = await ctx();
    await queueTargets(c.personalityId, c.accountId, 3);
    // Claimed over HTTP so the row lock, the guard and the real claim path are
    // all in the picture, rather than rows written straight into the table.
    await api.get(`/v1/accounts/${c.accountId}/targets?limit=3`, { auth: c.auth });

    const res = await api.post(`/api/accounts/${c.accountId}/reset-daily-cap`, { auth: c.auth });

    // 200, not Nest's default 201 for POST: nothing was created, and the body
    // is a report of what changed.
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'cleared',
      'handedToday',
      'id',
      'label',
      'remainingToday',
      'requeued',
    ]);
    // Two counts because they answer two questions: how many cap slots came
    // back, and how many rows were stuck mid-flight and are workable again.
    expect(res.body).toMatchObject({
      id: c.accountId,
      requeued: 3,
      cleared: 3,
      handedToday: 0,
      remainingToday: 50,
    });
  });

  it('GET /api/settings answers the four pacing numbers, the model, and nothing else', async () => {
    const c = await ctx();
    const res = await api.get('/api/settings', { auth: c.auth });
    expect(res.status).toBe(200);
    // Pinned as an exact set in both directions. A field that reaches the DTO
    // but misses the GET select saves and reads back unchanged, which on the
    // screen is indistinguishable from a save that never happened -- and a
    // field that leaks in here is a client's setting escaping into a reply
    // nobody audited.
    //
    // `models` is the one key here that is not a stored setting: it is the
    // closed option list the model dropdown is built from, served rather than
    // hardcoded in the UI so the two cannot drift.
    expect(Object.keys(res.body).sort()).toEqual([
      'dailyCapPerAccount',
      'extractionModel',
      'followPaceSeconds',
      'models',
      'sessionCapPerAccount',
      'sessionWindowMinutes',
    ]);
  });

  it('DELETE /api/personalities/:id answers 204 with no body', async () => {
    const c = await ctx();
    const res = await api.delete(`/api/personalities/${c.personalityId}`, { auth: c.auth });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await prisma.personality.findUnique({ where: { id: c.personalityId } })).toBeNull();
  });

  it('POST /v1/accounts/:id/targets/:handle/result answers {ok: true}', async () => {
    const c = await ctx();
    const [handle] = await queueTargets(c.personalityId, c.accountId, 1);
    const res = await api.post(`/v1/accounts/${c.accountId}/targets/${handle}/result`, {
      auth: c.auth,
      body: { result: 'skipped' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST /v1/accounts/:id/sheets rejects an upload with no image', async () => {
    const c = await ctx();
    const res = await api.post(`/v1/accounts/${c.accountId}/sheets`, { auth: c.auth });
    expect(res.status).toBe(400);
    expect(String(res.body?.message)).toContain('no image uploaded');
    // Nothing reached the queue on the failed path.
    expect(api.enqueued).toHaveLength(0);
  });
});
