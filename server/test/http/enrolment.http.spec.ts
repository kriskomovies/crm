/**
 * The one unauthenticated route, and everything that keeps it safe.
 *
 * POST /v1/enrol has no guard -- it cannot, it is how a machine with no
 * credential gets one -- so it is exempt from the auth matrix in
 * auth.http.spec.ts. That exemption is only defensible if the thing standing in
 * its place is tested at least as hard, which is what this file is.
 *
 * The property that matters: with no window open and no valid token, an
 * anonymous caller gets nothing. Everything else here is a corollary.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashApiKey } from '../../src/auth/api-key.guard';
import { dropFixtures, makeClient, prisma } from '../fixtures';
import { bootHarness, Harness } from './app';

let api: Harness;

beforeAll(async () => {
  api = await bootHarness();
});

/**
 * Close every window before each test, including on clients this file did not
 * create.
 *
 * enrol() looks at ALL clients globally -- it has to, the caller has no
 * credential and cannot say who it is -- so any seeded or demo client left with
 * a window open changes the answer here. Without this, opening a real window on
 * the dev database (which is exactly what you do while setting a machine up)
 * turned "enrolment is closed" into "enrolment is open" and "open on one
 * client" into "ambiguous", and seven tests went red for a reason that had
 * nothing to do with the code. dropFixtures only removes what the fixtures
 * made, so it cannot cover this.
 */
beforeEach(async () => {
  await prisma.client.updateMany({ data: { enrolOpenUntil: null } });
});

afterEach(dropFixtures);
afterAll(async () => {
  await api?.close();
  await prisma.$disconnect();
});

const enrol = (name = 'test-box') =>
  api.request('POST', '/v1/enrol', { body: { name } });

const enrolWith = (token: string, name = 'test-box') =>
  api.request('POST', '/v1/enrol', { body: { name, token } });

/** Give a client a known enrolment token, storing only its hash as the app does. */
async function giveToken(clientId: string, token: string): Promise<void> {
  await prisma.client.update({
    where: { id: clientId },
    data: { enrolTokenHash: hashApiKey(token) },
  });
}

describe('POST /v1/enrol with no window open', () => {
  it('refuses, even though it takes no key', async () => {
    await makeClient();
    const res = await enrol();
    expect(res.status).toBe(400);
    // The message is the one an operator reads on the machine they are setting
    // up, so it says what to do rather than only what went wrong.
    expect(String(res.body?.message)).toMatch(/enrolment is closed/i);
  });

  it('issues no key', async () => {
    const c = await makeClient();
    await enrol();
    // Scoped to this client: the count is global, and any machine enrolled
    // against the dev database for real would make a bare count() nonzero.
    expect(await prisma.apiKey.count({ where: { clientId: c.id } })).toBe(0);
  });
});

describe('POST /v1/enrol inside a window', () => {
  it('issues a key bound to that client, and returns its accounts', async () => {
    const c = await makeClient();
    await prisma.client.update({
      where: { id: c.id },
      data: { enrolOpenUntil: new Date(Date.now() + 60_000) },
    });

    const res = await enrol('emulator-07');
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^sk_/);
    expect(res.body.client.id).toBe(c.id);
    // The machine learns what to run from the server, so its config file holds
    // no identity at all -- that is the whole point of typing only an address.
    expect(Array.isArray(res.body.personalities)).toBe(true);

    const row = await prisma.apiKey.findFirstOrThrow({ where: { clientId: c.id } });
    expect(row.name).toBe('emulator-07');
    expect(row.revokedAt).toBeNull();
    // Only the hash is stored. A database dump must not hand anyone the ability
    // to drain a target queue.
    expect(row.hash).not.toContain(res.body.apiKey);
  });

  it('the issued key actually works on a guarded route', async () => {
    const c = await makeClient();
    await prisma.client.update({
      where: { id: c.id },
      data: { enrolOpenUntil: new Date(Date.now() + 60_000) },
    });
    const { body } = await enrol();

    // `auth` is sent VERBATIM by the harness, so the Bearer prefix is part of
    // what is being asserted -- a raw key with no scheme is one of the four
    // rejections the auth matrix requires.
    const ok = await api.request('GET', '/api/personalities', {
      auth: `Bearer ${body.apiKey}`,
    });
    expect(ok.status).toBe(200);
  });

  it('a revoked key stops working immediately', async () => {
    const c = await makeClient();
    await prisma.client.update({
      where: { id: c.id },
      data: { enrolOpenUntil: new Date(Date.now() + 60_000) },
    });
    const { body } = await enrol();
    const auth = `Bearer ${body.apiKey}`;
    const row = await prisma.apiKey.findFirstOrThrow({ where: { clientId: c.id } });

    // Prove it works FIRST. Asserting only the 401 would pass just as happily
    // if the key had never worked at all, which is exactly how this test was
    // green while the guard was rejecting every enrolled key.
    expect((await api.request('GET', '/api/personalities', { auth })).status).toBe(200);

    await prisma.apiKey.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });

    // Revoking is only meaningful if it takes effect at once -- that is what it
    // is for when a machine is lost.
    expect((await api.request('GET', '/api/personalities', { auth })).status).toBe(401);
  });
});

/**
 * The token exists so that nothing has to be left open to the internet. Every
 * test in here therefore runs with EVERY window shut -- that is the point, and
 * a test that opened one would be proving nothing.
 */
describe('POST /v1/enrol with an enrolment token', () => {
  it('enrols with no window open anywhere', async () => {
    const c = await makeClient();
    await giveToken(c.id, 'et_known_test_token');

    const res = await enrolWith('et_known_test_token', 'emulator-11');
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^sk_/);
    expect(res.body.client.id).toBe(c.id);

    const row = await prisma.apiKey.findFirstOrThrow({ where: { clientId: c.id } });
    expect(row.name).toBe('emulator-11');
    expect(row.revokedAt).toBeNull();
  });

  it('refuses a wrong token and issues nothing', async () => {
    const c = await makeClient();
    await giveToken(c.id, 'et_the_real_one');

    const res = await enrolWith('et_not_the_real_one');
    // 401, not 400: whoever is stood at the machine has to be able to tell "you
    // typed it wrong" apart from "the server is not accepting enrolments".
    expect(res.status).toBe(401);
    expect(await prisma.apiKey.count({ where: { clientId: c.id } })).toBe(0);
  });

  it('names its own client, so two tenants at once is not ambiguous', async () => {
    const a = await makeClient();
    const b = await makeClient();
    await giveToken(a.id, 'et_client_a');
    await giveToken(b.id, 'et_client_b');
    // Both windows open as well: the token must win outright rather than be
    // consulted after the ambiguity check that the window path would fail on.
    await prisma.client.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { enrolOpenUntil: new Date(Date.now() + 60_000) },
    });

    const res = await enrolWith('et_client_b');
    expect(res.status).toBe(201);
    expect(res.body.client.id).toBe(b.id);
    expect(await prisma.apiKey.count({ where: { clientId: a.id } })).toBe(0);
    expect(await prisma.apiKey.count({ where: { clientId: b.id } })).toBe(1);
  });

  it('is a bootstrap secret and not a working credential', async () => {
    const c = await makeClient();
    await giveToken(c.id, 'et_bootstrap_only');

    // The token opens exactly one door. If it also authenticated the guarded
    // routes it would be the shared key that api_keys exists to avoid, and
    // losing one box would mean rotating every box.
    const res = await api.request('GET', '/api/personalities', {
      auth: 'Bearer et_bootstrap_only',
    });
    expect(res.status).toBe(401);
  });

  it('rotating replaces the old token and leaves enrolled machines alone', async () => {
    const c = await makeClient();
    await giveToken(c.id, 'et_first');
    const { body } = await enrolWith('et_first');
    const auth = `Bearer ${body.apiKey}`;
    expect((await api.request('GET', '/api/personalities', { auth })).status).toBe(200);

    await giveToken(c.id, 'et_second');

    expect((await enrolWith('et_first')).status).toBe(401);
    expect((await enrolWith('et_second')).status).toBe(201);
    // The already-enrolled machine holds its own key and never presents the
    // token again, so a rotation must not knock it offline.
    expect((await api.request('GET', '/api/personalities', { auth })).status).toBe(200);
  });
});

describe('the window is a deadline, not a flag', () => {
  it('an expired window is closed', async () => {
    const c = await makeClient();
    await prisma.client.update({
      where: { id: c.id },
      // One second in the past: the failure mode this guards against is
      // "enrolment left switched on", so it must lapse without anyone acting.
      data: { enrolOpenUntil: new Date(Date.now() - 1_000) },
    });
    const res = await enrol();
    expect(res.status).toBe(400);
    expect(await prisma.apiKey.count({ where: { clientId: c.id } })).toBe(0);
  });

  it('two clients open at once is refused rather than guessed', async () => {
    const a = await makeClient();
    const b = await makeClient();
    const until = new Date(Date.now() + 60_000);
    await prisma.client.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { enrolOpenUntil: until },
    });

    const res = await enrol();
    // Picking one would silently attach someone's machine to the wrong ledger,
    // and the ledger is the product.
    expect(res.status).toBe(400);
    expect(String(res.body?.message)).toMatch(/ambiguous/i);
    expect(
      await prisma.apiKey.count({ where: { clientId: { in: [a.id, b.id] } } }),
    ).toBe(0);
  });
});
