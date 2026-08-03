/**
 * The DTOs, the global ValidationPipe, and the query params that never reach a
 * DTO at all.
 *
 * Every assertion checks the STATUS AND the body. A 400 whose body is
 * `{"statusCode":400}` costs an integrator an afternoon, and a validator that
 * fires on the wrong field is indistinguishable from one that works until
 * someone reads the message. So the tests below name the field they expect to
 * be blamed.
 *
 * A handful of cases pin behaviour that is WRONG rather than behaviour that is
 * right; each is marked and each is in the findings. Asserting the bug keeps the
 * suite honest -- it goes red the moment someone fixes it, which is the reminder
 * to come back here -- and it stops a green build from being read as a claim
 * that the input handling is sound.
 *
 * See the header of ./app.ts for why the pipe under test is the one this
 * harness installs rather than literally the one in main.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { addPeople, dropFixtures, makeClient, prisma, queueTargets, TestClient } from '../fixtures';
import { bootHarness, Harness } from './app';
import { ABSENT } from './routes';

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

/** class-validator answers with an array of messages; the rest of Nest with one. */
function messages(body: any): string {
  return Array.isArray(body?.message) ? body.message.join(' | ') : String(body?.message ?? '');
}

function expectRejected(res: { status: number; body: any }, blames: string) {
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  // The caller has to be able to tell WHICH field was refused. Without this the
  // assertion passes for a 400 raised by something else entirely.
  expect(messages(res.body)).toContain(blames);
}

describe('POST /api/personalities', () => {
  it('rejects a missing name', async () => {
    const c = await ctx();
    expectRejected(await api.post('/api/personalities', { auth: c.auth, body: {} }), 'name');
  });

  it('rejects a name that is not a string', async () => {
    const c = await ctx();
    expectRejected(
      await api.post('/api/personalities', { auth: c.auth, body: { name: 123 } }),
      'name must be a string',
    );
  });

  it('rejects a name over 80 characters', async () => {
    const c = await ctx();
    expectRejected(
      await api.post('/api/personalities', { auth: c.auth, body: { name: 'x'.repeat(81) } }),
      'name must be shorter than or equal to 80 characters',
    );
  });

  it('accepts a name of exactly 80 characters', async () => {
    const c = await ctx();
    const res = await api.post('/api/personalities', {
      auth: c.auth,
      body: { name: 'x'.repeat(80) },
    });
    expect(res.status).toBe(201);
  });

  it('rejects an unknown property rather than ignoring it', async () => {
    const c = await ctx();
    // forbidNonWhitelisted. This one matters beyond tidiness: `clientId` used to
    // be a body field that decided which tenant owned the new personality, and
    // silently dropping an unknown key is how a caller keeps believing it still
    // is one.
    expectRejected(
      await api.post('/api/personalities', {
        auth: c.auth,
        body: { name: 'kris', clientId: ABSENT },
      }),
      'property clientId should not exist',
    );
  });

  it('rejects a body that is not an object', async () => {
    const c = await ctx();
    const res = await api.post('/api/personalities', { auth: c.auth, body: [{ name: 'kris' }] });
    expect(res.status).toBe(400);
  });

  it('rejects a body that is not JSON', async () => {
    const c = await ctx();
    const res = await api.post('/api/personalities', { auth: c.auth, body: '{oops' });
    expect(res.status).toBe(400);
    expect(messages(res.body)).toContain('JSON');
  });

  it('refuses a duplicate name within one client', async () => {
    const c = await ctx();
    const first = await api.post('/api/personalities', { auth: c.auth, body: { name: 'mia' } });
    expect(first.status).toBe(201);
    const second = await api.post('/api/personalities', { auth: c.auth, body: { name: 'mia' } });
    expect(second.status).toBe(400);
    expect(messages(second.body)).toContain('already exists');
  });

  /**
   * DEFECT, pinned. CreatePersonalityDto is @IsString + @MaxLength(80) with no
   * lower bound and no trim, so "" and "   " are valid names. The row is
   * created, it takes the @@unique([clientId, name]) slot, and it renders as a
   * blank entry in the operator UI's personality dropdown -- the one the whole
   * stats screen filters on.
   */
  it('WRONG: accepts an empty name', async () => {
    const c = await ctx();
    const res = await api.post('/api/personalities', { auth: c.auth, body: { name: '' } });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('');
  });

  it('WRONG: accepts a whitespace-only name', async () => {
    const c = await ctx();
    const res = await api.post('/api/personalities', { auth: c.auth, body: { name: '   ' } });
    expect(res.status).toBe(201);
    // Untrimmed as well as unchecked, so "   " and "  " are two different
    // personalities that look identical everywhere they are displayed.
    expect(res.body.name).toBe('   ');
  });
});

describe('POST /api/personalities/:id/accounts', () => {
  it('refuses a per-account dailyCap outright, rather than ignoring it', async () => {
    const c = await ctx();
    // The cap is one client-wide setting now. forbidNonWhitelisted turning this
    // into a 400 is the point: accepting and silently dropping it would let an
    // operator believe they had capped one account differently.
    expectRejected(
      await api.post(`/api/personalities/${c.personalityId}/accounts`, {
        auth: c.auth,
        body: { label: 'snap_99', dailyCap: 1001 },
      }),
      'property dailyCap should not exist',
    );
  });

  it('rejects a missing label', async () => {
    const c = await ctx();
    expectRejected(
      await api.post(`/api/personalities/${c.personalityId}/accounts`, { auth: c.auth, body: {} }),
      'label',
    );
  });

  /** DEFECT, pinned -- same missing lower bound as the personality name. The
   *  label is what identifies an emulator in the handout logs. */
  it('WRONG: accepts an empty label', async () => {
    const c = await ctx();
    const res = await api.post(`/api/personalities/${c.personalityId}/accounts`, {
      auth: c.auth,
      body: { label: '' },
    });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('');
  });
});

describe('POST /api/personalities/:id/targets', () => {
  it('rejects an empty handles array', async () => {
    const c = await ctx();
    expectRejected(
      await api.post(`/api/personalities/${c.personalityId}/targets`, {
        auth: c.auth,
        body: { handles: [] },
      }),
      'handles should not be empty',
    );
  });

  it('rejects more than 1000 handles', async () => {
    const c = await ctx();
    expectRejected(
      await api.post(`/api/personalities/${c.personalityId}/targets`, {
        auth: c.auth,
        body: { handles: Array.from({ length: 1001 }, (_, i) => `walker_${i}`) },
      }),
      'handles must contain no more than 1000 elements',
    );
  });

  it('accepts exactly 1000 handles', async () => {
    const c = await ctx();
    // Implausible on purpose: the boundary under test is the DTO's, and a
    // thousand real handles would drag the whole attach-and-allocate path into
    // a test about array length.
    const res = await api.post(`/api/personalities/${c.personalityId}/targets`, {
      auth: c.auth,
      body: { handles: Array.from({ length: 1000 }, () => '!') },
    });
    expect(res.status).toBe(201);
    expect(res.body.invalid).toHaveLength(1000);
    expect(res.body.added).toEqual([]);
  });

  it('rejects handles that are not an array', async () => {
    const c = await ctx();
    expectRejected(
      await api.post(`/api/personalities/${c.personalityId}/targets`, {
        auth: c.auth,
        body: { handles: 'walker_1' },
      }),
      'handles must be an array',
    );
  });

  it('rejects a non-string element', async () => {
    const c = await ctx();
    expectRejected(
      await api.post(`/api/personalities/${c.personalityId}/targets`, {
        auth: c.auth,
        body: { handles: [123] },
      }),
      'each value in handles must be a string',
    );
  });

  it('rejects a handle longer than 200 characters', async () => {
    const c = await ctx();
    expectRejected(
      await api.post(`/api/personalities/${c.personalityId}/targets`, {
        auth: c.auth,
        body: { handles: ['h'.repeat(201)] },
      }),
      'each value in handles must be shorter than or equal to 200 characters',
    );
  });

  it('accepts a 200-character handle and reports it as invalid rather than storing it', async () => {
    const c = await ctx();
    const res = await api.post(`/api/personalities/${c.personalityId}/targets`, {
      auth: c.auth,
      body: { handles: ['h'.repeat(200)] },
    });
    // The DTO bound and the plausibility rule are different questions: 200 chars
    // is a legal request carrying transcription noise, and noise is echoed back
    // rather than silently dropped.
    expect(res.status).toBe(201);
    expect(res.body.invalid).toEqual(['h'.repeat(200)]);
    expect(res.body.added).toEqual([]);
  });

  it('rejects an unknown source value', async () => {
    const c = await ctx();
    expectRejected(
      await api.post(`/api/personalities/${c.personalityId}/targets`, {
        auth: c.auth,
        body: { handles: ['walker_1'], source: 'imported' },
      }),
      'source must be one of the following values: manual, extraction',
    );
  });

  it('accepts the documented source values', async () => {
    const c = await ctx();
    for (const source of ['manual', 'extraction']) {
      const res = await api.post(`/api/personalities/${c.personalityId}/targets`, {
        auth: c.auth,
        body: { handles: [`from_${source}`], source },
      });
      expect(res.status).toBe(201);
      expect(res.body.added).toEqual([`from_${source}`]);
    }
  });

  it('rejects an unknown property', async () => {
    const c = await ctx();
    expectRejected(
      await api.post(`/api/personalities/${c.personalityId}/targets`, {
        auth: c.auth,
        body: { handles: ['walker_1'], personalityId: ABSENT },
      }),
      'property personalityId should not exist',
    );
  });
});

describe('PATCH /api/accounts/:id', () => {
  it.each([
    // dailyCap is no longer a property of an account, so it is rejected as an
    // unknown one. That is the whole contract of this route now: pause and
    // resume, nothing else.
    ['a dailyCap', { dailyCap: 100 }, 'property dailyCap should not exist'],
    ['a non-boolean enabled', { enabled: 'yes' }, 'enabled must be a boolean value'],
    ['an unknown property', { label: 'renamed' }, 'property label should not exist'],
  ])('rejects %s', async (_label, body, blames) => {
    const c = await ctx();
    expectRejected(await api.patch(`/api/accounts/${c.accountId}`, { auth: c.auth, body }), blames);
    // Nothing may have been written on the way to the 400.
    const account = await prisma.account.findUniqueOrThrow({ where: { id: c.accountId } });
    expect(account.enabled).toBe(true);
  });

  it('treats an empty patch as a no-op rather than an error', async () => {
    const c = await ctx();
    const res = await api.patch(`/api/accounts/${c.accountId}`, { auth: c.auth, body: {} });
    expect(res.status).toBe(200);
    // dailyCap is still reported -- it is what meters this account -- it just
    // comes from the client and cannot be set from here.
    expect(res.body).toMatchObject({ id: c.accountId, dailyCap: 50, enabled: true });
  });
});

describe('PUT /api/settings', () => {
  it.each([
    ['a negative cap', { dailyCapPerAccount: -1 }, 'dailyCapPerAccount must not be less than 0'],
    [
      'a cap over 2000',
      { dailyCapPerAccount: 2001 },
      'dailyCapPerAccount must not be greater than 2000',
    ],
    [
      'a fractional cap',
      { dailyCapPerAccount: 1.5 },
      'dailyCapPerAccount must be an integer number',
    ],
    [
      'a cap sent as a string',
      { dailyCapPerAccount: '50' },
      'dailyCapPerAccount must be an integer number',
    ],
    ['a negative pace', { followPaceSeconds: -1 }, 'followPaceSeconds must not be less than 0'],
    [
      'a pace over an hour',
      { followPaceSeconds: 3601 },
      'followPaceSeconds must not be greater than 3600',
    ],
    ['an unknown property', { dailyCap: 10 }, 'property dailyCap should not exist'],
  ])('rejects %s', async (_label, body, blames) => {
    const c = await ctx();
    expectRejected(await api.request('PUT', '/api/settings', { auth: c.auth, body }), blames);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: c.client.id } });
    expect(client.dailyCapPerAccount).toBe(50);
  });

  it.each([0, 2000])('accepts the boundary cap %i', async (dailyCapPerAccount) => {
    const c = await ctx();
    const res = await api.request('PUT', '/api/settings', {
      auth: c.auth,
      body: { dailyCapPerAccount },
    });
    expect(res.status).toBe(200);
    expect(res.body.dailyCapPerAccount).toBe(dailyCapPerAccount);
  });

  it('takes one field without disturbing the other', async () => {
    const c = await ctx();
    const res = await api.request('PUT', '/api/settings', {
      auth: c.auth,
      body: { followPaceSeconds: 9 },
    });
    expect(res.status).toBe(200);
    // A screen that edits one number must not have to restate the other and
    // risk stamping a stale value over someone else's edit.
    expect(res.body).toMatchObject({ followPaceSeconds: 9, dailyCapPerAccount: 50 });
  });
});

describe('POST /v1/accounts/:id/targets/:handle/result', () => {
  it('rejects an unknown result value and names the three that are allowed', async () => {
    const c = await ctx();
    const [handle] = await queueTargets(c.personalityId, c.accountId, 1);
    expectRejected(
      await api.post(`/v1/accounts/${c.accountId}/targets/${handle}/result`, {
        auth: c.auth,
        body: { result: 'maybe' },
      }),
      'result must be one of the following values: followed, failed, skipped',
    );
  });

  it('rejects a missing result', async () => {
    const c = await ctx();
    const [handle] = await queueTargets(c.personalityId, c.accountId, 1);
    expectRejected(
      await api.post(`/v1/accounts/${c.accountId}/targets/${handle}/result`, {
        auth: c.auth,
        body: {},
      }),
      'result',
    );
  });

  it('rejects a note over 500 characters', async () => {
    const c = await ctx();
    const [handle] = await queueTargets(c.personalityId, c.accountId, 1);
    expectRejected(
      await api.post(`/v1/accounts/${c.accountId}/targets/${handle}/result`, {
        auth: c.auth,
        body: { result: 'followed', note: 'n'.repeat(501) },
      }),
      'note must be shorter than or equal to 500 characters',
    );
  });

  it('rejects an unknown property', async () => {
    const c = await ctx();
    const [handle] = await queueTargets(c.personalityId, c.accountId, 1);
    expectRejected(
      await api.post(`/v1/accounts/${c.accountId}/targets/${handle}/result`, {
        auth: c.auth,
        body: { result: 'followed', bogus: true },
      }),
      'property bogus should not exist',
    );
  });

  it('accepts a valid report and 404s an unknown handle', async () => {
    const c = await ctx();
    const [handle] = await queueTargets(c.personalityId, c.accountId, 1);

    const ok = await api.post(`/v1/accounts/${c.accountId}/targets/${handle}/result`, {
      auth: c.auth,
      body: { result: 'followed', note: 'done' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ ok: true });

    const missing = await api.post(`/v1/accounts/${c.accountId}/targets/nobodyhere/result`, {
      auth: c.auth,
      body: { result: 'followed' },
    });
    expect(missing.status).toBe(404);
    expect(messages(missing.body)).toContain('unknown handle');
  });
});

describe('the limit query param', () => {
  it('clamps an absurdly large limit to 500 instead of falling over', async () => {
    const c = await ctx();
    await addPeople(c.personalityId, 520);

    const res = await api.get(`/api/personalities/${c.personalityId}/targets?limit=1000000`, {
      auth: c.auth,
    });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(500);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it.each(['-5', '0'])('clamps limit=%s to one row rather than erroring', async (limit) => {
    const c = await ctx();
    await addPeople(c.personalityId, 3);
    const res = await api.get(`/api/personalities/${c.personalityId}/targets?limit=${limit}`, {
      auth: c.auth,
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('rejects a fractional limit', async () => {
    const c = await ctx();
    const res = await api.get(`/api/personalities/${c.personalityId}/targets?limit=9.5`, {
      auth: c.auth,
    });
    expect(res.status).toBe(400);
    expect(messages(res.body)).toContain('numeric string is expected');
  });

  /**
   * DEFECT, pinned. ParseIntPipe cannot reject anything on these routes: the
   * global ValidationPipe runs first with transform:true, coerces the raw query
   * string with `+value`, and hands ParseIntPipe a number. "abc" becomes NaN,
   * DefaultValuePipe treats NaN as absent, and the request quietly gets the
   * default page size.
   *
   * The result is an API that refuses `?limit=9.5` and accepts `?limit=abc`.
   */
  it('WRONG: silently ignores a non-numeric limit instead of rejecting it', async () => {
    const c = await ctx();
    await addPeople(c.personalityId, 3);
    const url = `/api/personalities/${c.personalityId}/targets`;

    const garbage = await api.get(`${url}?limit=abc`, { auth: c.auth });
    const honoured = await api.get(`${url}?limit=1`, { auth: c.auth });

    expect(garbage.status).toBe(200);
    // The contrast is the proof. A limit that is honoured returns one row; the
    // garbage one returns all three, which is DefaultValuePipe(100) having been
    // substituted -- not a 400, and not the clamp-to-1 that `?limit=0` gets.
    expect(honoured.body.items).toHaveLength(1);
    expect(garbage.body.items).toHaveLength(3);
  });

  it('WRONG: reads an empty limit as zero and returns one row', async () => {
    const c = await ctx();
    await addPeople(c.personalityId, 3);
    // `?limit=&cursor=` is what a UI sends when nothing is selected, and the
    // documented shape of the other query strings in this API.
    const res = await api.get(`/api/personalities/${c.personalityId}/targets?limit=`, {
      auth: c.auth,
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('caps the metered claim at 100 however large a limit is asked for', async () => {
    const c = await ctx();
    await queueTargets(c.personalityId, c.accountId, 120);
    // The cap has to be lifted out of the way first, or this measures the cap
    // rather than the limit clamp. It is a client setting now, not a patch on
    // the account.
    await api.request('PUT', '/api/settings', {
      auth: c.auth,
      body: { dailyCapPerAccount: 1000 },
    });

    const res = await api.get(`/v1/accounts/${c.accountId}/targets?limit=99999`, { auth: c.auth });

    expect(res.status).toBe(200);
    expect(res.body.targets).toHaveLength(100);
  });
});

describe('the cursor query param', () => {
  /**
   * DEFECT, pinned, and it applies to every list endpoint.
   *
   * Prisma resolves a cursor by looking the row up, so an id that no longer
   * exists produces an empty page -- 200, `items: []`, `nextCursor: null`. That
   * is byte-identical to "you have reached the end of the list".
   *
   * Concretely: an integrator stores nextCursor, the person on that row is
   * removed (a personality delete cascades, a client re-imports), and the next
   * poll reports the ledger as fully walked. Nothing anywhere says otherwise.
   */
  it.each([
    ['targets', (id: string) => `/api/personalities/${id}/targets`],
    ['ledger', (id: string) => `/v1/personalities/${id}/ledger`],
  ])('WRONG: %s treats an unknown cursor as the end of the list', async (_label, url) => {
    const c = await ctx();
    await addPeople(c.personalityId, 5);

    const res = await api.get(`${url(c.personalityId)}?cursor=${ABSENT}`, { auth: c.auth });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('WRONG: /api/sheets treats an unknown cursor as the end of the list', async () => {
    const c = await ctx();
    const res = await api.get(`/api/sheets?cursor=${ABSENT}`, { auth: c.auth });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it('walks a real cursor through the query string without losing or repeating a row', async () => {
    const c = await ctx();
    const expected = await addPeople(c.personalityId, 25);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const qs: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await api.get(
        `/api/personalities/${c.personalityId}/targets?limit=10${qs}`,
        { auth: c.auth },
      );
      expect(res.status).toBe(200);
      for (const item of res.body.items) seen.push(item.handle);
      cursor = res.body.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect([...seen].sort()).toEqual([...expected].sort());
  });
});

describe('the state and q query params', () => {
  it('rejects an unknown state and lists the five that exist', async () => {
    const c = await ctx();
    const res = await api.get(`/api/personalities/${c.personalityId}/targets?state=bogus`, {
      auth: c.auth,
    });
    expect(res.status).toBe(400);
    // The caller gets to know which of the five it should have sent; an
    // unchecked cast used to make this a 500 out of the query engine.
    expect(messages(res.body)).toContain('queued, handed_out, followed, failed, skipped');
  });

  it('filters on a known state', async () => {
    const c = await ctx();
    await queueTargets(c.personalityId, c.accountId, 4);
    await addPeople(c.personalityId, 3, 'unassigned');

    const res = await api.get(`/api/personalities/${c.personalityId}/targets?state=queued`, {
      auth: c.auth,
    });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(4);
  });

  it('survives a search string far longer than any display name', async () => {
    const c = await ctx();
    await addPeople(c.personalityId, 3);
    // Bounded to 100 chars before it becomes a LIKE with the caller's text
    // inlined between two wildcards.
    const res = await api.get(
      `/api/personalities/${c.personalityId}/targets?q=${'a'.repeat(5000)}`,
      { auth: c.auth },
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('/api/stats query params', () => {
  it('rejects a from that is not a date', async () => {
    const c = await ctx();
    const res = await api.get('/api/stats?from=notadate', { auth: c.auth });
    expect(res.status).toBe(400);
    expect(messages(res.body)).toContain('from is not a date');
  });

  it('rejects a range that runs backwards', async () => {
    const c = await ctx();
    const res = await api.get('/api/stats?from=2026-07-30&to=2026-07-01', { auth: c.auth });
    expect(res.status).toBe(400);
    expect(messages(res.body)).toContain('from must not be later than to');
  });

  it('rejects a window wider than 400 days', async () => {
    const c = await ctx();
    // A bookmarked ?from=2000-01-01 is otherwise a decade-long scan nobody is
    // watching.
    const res = await api.get('/api/stats?from=2000-01-01&to=2026-07-30', { auth: c.auth });
    expect(res.status).toBe(400);
    expect(messages(res.body)).toContain('range must not exceed 400 days');
  });

  it('404s an unknown personalityId', async () => {
    const c = await ctx();
    const res = await api.get(`/api/stats?personalityId=${ABSENT}`, { auth: c.auth });
    expect(res.status).toBe(404);
  });

  /**
   * DEFECT, pinned, and quiet. Query params bypass the DTO layer entirely, so
   * forbidNonWhitelisted never sees them: a misspelled `?personality_id=<id>`
   * is dropped and the response is the whole client's estate rather than the
   * one personality that was asked for. It looks like a working request.
   */
  it('WRONG: ignores an unknown query param instead of rejecting it', async () => {
    const c = await ctx();
    await addPeople(c.personalityId, 3);
    const res = await api.get(`/api/stats?personality_id=${ABSENT}&bogus=1`, { auth: c.auth });
    expect(res.status).toBe(200);
    expect(res.body.totals.targets).toBe(3);
  });
});
