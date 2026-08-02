/**
 * The one unauthenticated route, and everything that keeps it safe.
 *
 * POST /v1/enrol has no guard -- it cannot, it is how a machine with no
 * credential gets one -- so it is exempt from the auth matrix in
 * auth.http.spec.ts. That exemption is only defensible if the thing standing in
 * its place is tested at least as hard, which is what this file is.
 *
 * The property that matters: with no window open, an anonymous caller gets
 * nothing. Everything else here is a corollary.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { dropFixtures, makeClient, prisma } from '../fixtures';
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

const enrol = (name = 'test-box') =>
  api.request('POST', '/v1/enrol', { body: { name } });

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
    await makeClient();
    await enrol();
    expect(await prisma.apiKey.count()).toBe(0);
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
    expect(await prisma.apiKey.count()).toBe(0);
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
    expect(await prisma.apiKey.count()).toBe(0);
  });
});
