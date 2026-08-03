/**
 * A machine creating its own account: POST /v1/personalities/:id/accounts.
 *
 * The operator now creates ONLY a personality. The machine reads the Snapchat
 * handle off its emulator's own profile screen and registers the account itself,
 * so the label in the CRM is one nobody typed anywhere.
 *
 * The load-bearing property is that a REPEAT is not an error. Every restart of
 * an already-registered machine sends the same handle again -- it does not trust
 * an account it did not register itself, and the client-wide roster cannot tell
 * it which account is its own -- so the second call must answer with the first
 * call's account. If it 409'd or 400'd instead, a machine that had already
 * registered could never resolve its account again and would never run.
 *
 * That is also why 409 is narrow: it means the handle belongs to a DIFFERENT
 * personality of this client, i.e. the operator picked the wrong personality for
 * this emulator. Nothing downstream can detect that, so it has to be loud.
 *
 * Contract source: CRM-CHANGES.md in the snap-automation repo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { addPersonality, dropFixtures, makeClient, prisma, queueTargets } from '../fixtures';
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

/** A client whose personality has no accounts -- what the new flow selects. */
const bare = () => makeClient({ accounts: 0 });

function register(
  personalityId: string,
  auth: string,
  body: Record<string, unknown>,
) {
  return api.post(`/v1/personalities/${personalityId}/accounts`, {
    auth: `Bearer ${auth}`,
    body,
  });
}

describe('registering an account that does not exist yet', () => {
  it('creates it, answers 201, and nests the account the list shape uses', async () => {
    const c = await bare();

    const res = await register(c.personality.id, c.apiKey, {
      handle: 'iraxcvp',
      displayName: 'BABU__556671',
      machine: 'WIN-4C21A7',
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    // The agent adopts this object and starts its first cycle from it without a
    // second fetch, so the live counters have to be here and have to be right.
    expect(res.body.account).toMatchObject({
      label: 'iraxcvp',
      enabled: true,
      handedToday: 0,
      queued: 0,
      followed: 0,
    });
    expect(res.body.account.id).toEqual(expect.any(String));
    expect(res.body.account.remainingToday).toBe(res.body.account.dailyCap);
  });

  it('is metered by the client setting; the machine cannot ask for a cap', async () => {
    const c = await bare();

    // The cap is one number for the whole client, set on the Settings screen.
    // forbidNonWhitelisted is what makes an attempt to send one a rejection
    // rather than a silent no-op.
    const rejected = await register(c.personality.id, c.apiKey, {
      handle: 'iraxcvp',
      dailyCap: 500,
    });
    expect(rejected.status).toBe(400);

    const { body } = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });
    const client = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(body.account.dailyCap).toBe(client.dailyCapPerAccount);
  });

  it('adopts a cap change without the account being touched', async () => {
    const c = await bare();
    const { body } = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });
    expect(body.account.dailyCap).toBe(50);

    await api.request('PUT', '/api/settings', {
      auth: `Bearer ${c.apiKey}`,
      body: { dailyCapPerAccount: 240 },
    });

    // The point of one setting: nothing was written to the account row, and it
    // is metered at the new number from its very next claim.
    const again = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });
    expect(again.body.account.dailyCap).toBe(240);
    expect(again.body.account.remainingToday).toBe(240);
  });

  it('stores what the machine saw, and keeps it out of the reply', async () => {
    const c = await bare();

    const { body } = await register(c.personality.id, c.apiKey, {
      handle: 'iraxcvp',
      displayName: 'BABU__556671',
      machine: 'WIN-4C21A7',
    });

    // Operator context, not contract. The agent parses `account` and a field it
    // did not expect there is noise; the CRM is where these are read.
    const row = await prisma.account.findUniqueOrThrow({ where: { id: body.account.id } });
    expect(row.displayName).toBe('BABU__556671');
    expect(row.machine).toBe('WIN-4C21A7');
    expect(body.account).not.toHaveProperty('machine');
  });

  it('leaves them null when the machine sends nothing', async () => {
    const c = await bare();
    const { body } = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });

    const row = await prisma.account.findUniqueOrThrow({ where: { id: body.account.id } });
    expect(row.displayName).toBeNull();
    expect(row.machine).toBeNull();
  });

  it('a second handle under the same personality is a second account', async () => {
    const c = await bare();

    const first = await register(c.personality.id, c.apiKey, { handle: 'acceptcheck01' });
    const second = await register(c.personality.id, c.apiKey, { handle: 'acceptcheck02' });

    // Two machines under one personality. The second registration is not a
    // replacement of the first -- each emulator drives its own account and its
    // own daily cap.
    expect(second.status).toBe(201);
    expect(second.body.account.id).not.toBe(first.body.account.id);
    expect(await prisma.account.count({ where: { personalityId: c.personality.id } })).toBe(2);
  });
});

describe('registering a handle that is already this personality\'s', () => {
  it('answers 200 with the SAME account, not an error', async () => {
    const c = await bare();
    const first = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });

    const again = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });

    // The single most load-bearing behaviour in this endpoint: this is the path
    // every restart of a registered machine takes.
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.account.id).toBe(first.body.account.id);
    expect(await prisma.account.count({ where: { personalityId: c.personality.id } })).toBe(1);
  });

  it('normalises before matching, so a re-read that differs in case still lands', async () => {
    const c = await bare();
    const first = await register(c.personality.id, c.apiKey, { handle: 'acceptcheck01' });

    // OCR and uiautomator disagree about leading @ and capitalisation far more
    // often than about letters. Treating those as a new handle would give one
    // emulator two accounts.
    const again = await register(c.personality.id, c.apiKey, { handle: '  @AcceptCheck01 ' });

    expect(again.status).toBe(200);
    expect(again.body.account.id).toBe(first.body.account.id);
    expect(again.body.account.label).toBe('acceptcheck01');
  });

  it('reports live counters on the existing account, not zeroes', async () => {
    const c = await bare();
    const { body } = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });
    await queueTargets(c.personality.id, body.account.id, 3);

    const again = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });

    // A machine coming back after a restart adopts this object and works from
    // it. Answering 0 queued would have it back off as though there were
    // nothing to do.
    expect(again.body.account.queued).toBe(3);
  });
});

describe('the refusals', () => {
  it('400s on a handle that is not one, quoting what was sent', async () => {
    const c = await bare();

    const res = await register(c.personality.id, c.apiKey, { handle: 'NOT a handle!' });

    expect(res.status).toBe(400);
    // Read by whoever is stood at the machine: the usual cause is a misread
    // screen, so the message has to show what the screen was read as.
    expect(String(res.body.message)).toContain('NOT a handle!');
    expect(await prisma.account.count({ where: { personalityId: c.personality.id } })).toBe(0);
  });

  it('404s on a personality that does not exist', async () => {
    const c = await bare();
    const res = await register(ABSENT, c.apiKey, { handle: 'iraxcvp' });
    expect(res.status).toBe(404);
  });

  it('404s on another client\'s personality, saying nothing about it', async () => {
    const mine = await bare();
    const theirs = await bare();

    const res = await register(theirs.personality.id, mine.apiKey, { handle: 'iraxcvp' });

    // Not 403: the id is the secret, and "not yours" must be indistinguishable
    // from "not found" -- the same rule /v1/accounts/:id/targets follows.
    expect(res.status).toBe(404);
    expect(await prisma.account.count({ where: { personalityId: theirs.personality.id } })).toBe(0);
  });

  it('409s when the handle belongs to another personality of the same client', async () => {
    const c = await bare();
    const other = await addPersonality(c.id, { accounts: 0 });
    await register(other.id, c.apiKey, { handle: 'iraxcvp' });

    const res = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });

    // The operator picked the wrong personality for this emulator. Absorbing it
    // silently would have two personalities driving one Snapchat account.
    expect(res.status).toBe(409);
    expect(String(res.body.message)).toContain(other.name);
    expect(await prisma.account.count({ where: { personalityId: c.personality.id } })).toBe(0);
  });

  it('lets two clients hold the same handle', async () => {
    const mine = await bare();
    const theirs = await bare();
    await register(theirs.personality.id, theirs.apiKey, { handle: 'iraxcvp' });

    // The conflict is scoped to one client. Two tenants naming the same handle
    // are two unrelated Snapchat accounts as far as this server can tell, and
    // refusing would leak that the other tenant holds it.
    const res = await register(mine.personality.id, mine.apiKey, { handle: 'iraxcvp' });
    expect(res.status).toBe(201);
  });
});

describe('the account-less personality invariant', () => {
  it('GET /api/personalities lists a personality with no accounts', async () => {
    const c = await bare();

    const res = await api.get('/api/personalities', { auth: `Bearer ${c.apiKey}` });

    // Precisely what the new flow selects. A filter that hid empty
    // personalities would leave the operator nothing to pick.
    const mine = res.body.items.find((p: any) => p.id === c.personality.id);
    expect(mine).toBeDefined();
    expect(mine.accounts).toEqual([]);
  });

  it('and the registered account then appears there in the same shape', async () => {
    const c = await bare();
    const { body } = await register(c.personality.id, c.apiKey, { handle: 'iraxcvp' });

    const res = await api.get('/api/personalities', { auth: `Bearer ${c.apiKey}` });

    // One shape, one code path. The agent adopts the registration reply as
    // though it had read it from this list, so a field in one and not the other
    // is a field it silently stops finding.
    const listed = res.body.items.find((p: any) => p.id === c.personality.id).accounts[0];
    expect(listed).toEqual(body.account);
  });
});
