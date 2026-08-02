/**
 * ApiKeyGuard, over every route the application serves.
 *
 * This suite is the answer to a bug that was live in this repo hours ago: /api/*
 * carried no guard at all, so a personality id -- a uuid the operator UI prints
 * in a URL -- was enough to read, extend or DELETE another tenant's ledger, and
 * GET /api/stats handed the whole estate's spend to anyone who asked. The fix
 * was four @UseGuards lines. Nothing in the test suite could have told you they
 * were missing, and nothing would tell you about the fifth controller either.
 *
 * So the matrix is exhaustive by construction rather than by judgement: the
 * route list is compared against Express's own router first, and then every
 * route in it is required to reject four different ways of not being
 * authenticated. A route added without a guard fails here whether or not anyone
 * remembered this file.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { dropFixtures, makeClient, prisma } from '../fixtures';
import { bootHarness, Harness } from './app';
import { declaredRoutes, ROUTES } from './routes';

let api: Harness;

beforeAll(async () => {
  api = await bootHarness();
});
afterEach(dropFixtures);
afterAll(async () => {
  await api?.close();
  await prisma.$disconnect();
});

describe('the route table', () => {
  /**
   * The drift check. Everything else in this file iterates ROUTES, so a route
   * that exists but is not listed would be tested by nothing at all -- which is
   * precisely the state the unguarded /api/* controllers were in.
   */
  it('matches the routes Express actually serves', () => {
    // Exact equality in both directions: a route that vanished is as much a
    // contract break as one that appeared unguarded.
    expect(api.routes()).toEqual(declaredRoutes());
  });
});

/**
 * Four rejections per route.
 *
 * Guards run before pipes in Nest, so a request with no body and a nonsense
 * path param still has to be refused by the guard rather than by validation --
 * which is why every case below asserts 401 specifically, not "an error".
 */
describe.each(ROUTES)('$method $path', (route) => {
  const send = (auth?: string) =>
    api.request(route.method, route.sample, {
      ...(auth === undefined ? {} : { auth }),
      ...(route.body === undefined ? {} : { body: route.body }),
    });

  it('rejects a request with no Authorization header', async () => {
    const res = await send();
    expect(res.status).toBe(401);
    // The body has to say which of the two failures it was: "missing" and
    // "invalid" send an integrator to completely different places.
    // 'not signed in', not 'missing API key': a browser authenticates with a
    // session cookie and never has a key, so naming the key would be wrong for
    // half the callers this rejects.
    expect(res.body).toMatchObject({ statusCode: 401, message: 'not signed in' });
  });

  it.each([
    ['empty', ''],
    ['scheme only', 'Bearer'],
    ['scheme and nothing', 'Bearer '],
    ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['a raw key with no scheme', 'int-key-whatever'],
  ])('rejects a malformed header (%s)', async (_label, header) => {
    const res = await send(header);
    expect(res.status).toBe(401);
  });

  it('rejects a well-formed but unknown key', async () => {
    const res = await send('Bearer int-key-00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ statusCode: 401, message: 'invalid API key' });
  });

  it('does not reject a valid key', async () => {
    const client = await makeClient();
    const res = await send(`Bearer ${client.apiKey}`);
    // Deliberately "not 401" rather than a specific code. The path params are
    // absent ids, so most of these are a 404 and a couple are a 400; what is
    // under test is that the guard let the request through to find that out.
    expect(res.status).not.toBe(401);
  });
});

/**
 * Two behaviours of the guard that are not in the documented contract.
 *
 * Asserted as they are today rather than as they arguably should be, so this
 * file stays green and the disagreement is a report item instead of a broken
 * build. Both are written up in the findings.
 */
describe('undocumented edges of the guard', () => {
  it('accepts the key in an x-api-key header as well as in Authorization', async () => {
    const client = await makeClient();
    const res = await api.get('/api/personalities', {
      headers: { 'x-api-key': client.apiKey },
    });
    // A second credential channel nobody documented. It works, so anything that
    // audits, redacts or rate-limits on Authorization alone misses it.
    expect(res.status).toBe(200);
  });

  it('rejects a lowercase "bearer" scheme, which RFC 7235 says is case-insensitive', async () => {
    const client = await makeClient();
    const res = await api.get('/api/personalities', { auth: `bearer ${client.apiKey}` });
    // startsWith('Bearer ') is a case-sensitive compare, so the header falls
    // through to the x-api-key branch and the caller is told their key is
    // missing -- with a valid key in the request.
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ message: 'not signed in' });
  });

  it('tolerates surrounding whitespace in the key itself', async () => {
    const client = await makeClient();
    const res = await api.get('/api/personalities', { auth: `Bearer  ${client.apiKey}  ` });
    // hashApiKey trims, so this is intentional and worth pinning: a key pasted
    // out of a spreadsheet works.
    expect(res.status).toBe(200);
  });

  it('does not leak whether an unknown key belongs to a real client', async () => {
    const client = await makeClient();
    const unknown = await api.get('/api/personalities', { auth: 'Bearer int-key-not-issued' });
    const revoked = await api.get('/api/personalities', {
      auth: `Bearer ${client.apiKey}-with-a-suffix`,
    });
    expect(unknown.status).toBe(401);
    expect(revoked.status).toBe(401);
    expect(unknown.body.message).toBe(revoked.body.message);
  });
});
