/**
 * The invariant the product is sold on, tested against the real constraint.
 *
 *   Person @@unique([personalityId, handle])
 *
 * Scoped, not global. Two personalities holding the same handle is the expected
 * case and must stay legal; the same personality holding it twice must not. The
 * failure mode a global unique would cause is silent -- the second personality
 * simply never grows, every attach reports "duplicate", and nothing errors --
 * so it is worth an explicit test rather than trust in the schema file.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  addPersonality,
  dropFixtures,
  makeClient,
  personalities,
  prisma,
} from './fixtures';

afterEach(dropFixtures);
afterAll(() => prisma.$disconnect());

describe('per-personality uniqueness', () => {
  it('lets two personalities of one client hold the same handle', async () => {
    const client = await makeClient();
    const kris = client.personality;
    const mia = await addPersonality(client.id);

    const a = await personalities.attach(client.id, kris.id, ['@shared_target'], 'manual');
    const b = await personalities.attach(client.id, mia.id, ['@shared_target'], 'manual');

    expect(a.added).toEqual(['shared_target']);
    expect(a.duplicate).toEqual([]);
    // The second personality must see a NEW handle, not a duplicate.
    expect(b.added).toEqual(['shared_target']);
    expect(b.duplicate).toEqual([]);

    const rows = await prisma.person.findMany({
      where: { handle: 'shared_target', personalityId: { in: [kris.id, mia.id] } },
      include: { assignment: { include: { account: true } } },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);

    // Each personality gets its OWN assignment, on its OWN account. Sharing one
    // would mean one account being told to follow on another's behalf.
    for (const row of rows) {
      expect(row.assignment).not.toBeNull();
      expect(row.assignment!.account.personalityId).toBe(row.personalityId);
    }
    expect(rows[0].assignment!.id).not.toBe(rows[1].assignment!.id);
    expect(a.queued).toBe(1);
    expect(b.queued).toBe(1);
  });

  it('lets personalities of two different clients hold the same handle', async () => {
    const one = await makeClient();
    const two = await makeClient();

    const a = await personalities.attach(one.id, one.personality.id, ['crosstenant'], 'manual');
    const b = await personalities.attach(two.id, two.personality.id, ['crosstenant'], 'manual');

    expect(a.added).toEqual(['crosstenant']);
    expect(b.added).toEqual(['crosstenant']);
    expect(
      await prisma.person.count({
        where: {
          handle: 'crosstenant',
          personalityId: { in: [one.personality.id, two.personality.id] },
        },
      }),
    ).toBe(2);
  });

  it('refuses the same handle twice within one personality', async () => {
    const client = await makeClient();
    const kris = client.personality;

    const first = await personalities.attach(client.id, kris.id, ['@repeat_me'], 'manual');
    const second = await personalities.attach(client.id, kris.id, ['@repeat_me'], 'manual');

    expect(first.added).toEqual(['repeat_me']);
    expect(second.added).toEqual([]);
    expect(second.duplicate).toEqual(['repeat_me']);
    expect(second.queued).toBe(0);

    expect(await prisma.person.count({ where: { personalityId: kris.id } })).toBe(1);
    expect(
      await prisma.assignment.count({ where: { person: { personalityId: kris.id } } }),
    ).toBe(1);
  });

  it('keeps the two personalities apart across a mixed batch', async () => {
    const client = await makeClient();
    const kris = client.personality;
    const mia = await addPersonality(client.id);

    await personalities.attach(client.id, kris.id, ['alpha_one', 'beta_two'], 'manual');
    const second = await personalities.attach(
      client.id,
      mia.id,
      ['alpha_one', 'gamma_three'],
      'manual',
    );

    // alpha_one is kris's, and that is no reason for mia not to have it too.
    expect(second.added.sort()).toEqual(['alpha_one', 'gamma_three']);
    expect(second.duplicate).toEqual([]);
    expect(await prisma.person.count({ where: { personalityId: kris.id } })).toBe(2);
    expect(await prisma.person.count({ where: { personalityId: mia.id } })).toBe(2);
  });

  it('normalises before deduping, so @X and x are the same person', async () => {
    const client = await makeClient();
    const kris = client.personality;

    await personalities.attach(client.id, kris.id, ['@CaseFolded'], 'manual');
    const again = await personalities.attach(client.id, kris.id, ['  casefolded '], 'manual');

    expect(again.duplicate).toEqual(['casefolded']);
    expect(await prisma.person.count({ where: { personalityId: kris.id } })).toBe(1);
  });

  it('collapses a handle repeated inside one request without calling it a duplicate', async () => {
    const client = await makeClient();
    const result = await personalities.attach(
      client.id,
      client.personality.id,
      ['twice_over', '@twice_over'],
      'manual',
    );

    expect(result.added).toEqual(['twice_over']);
    // Redundant, not an error: the caller sent one handle written two ways.
    expect(result.duplicate).toEqual([]);
    expect(await prisma.person.count({ where: { personalityId: client.personality.id } })).toBe(1);
  });
});

describe('tenant scoping', () => {
  it('will not let one client attach to another client s personality', async () => {
    const mine = await makeClient();
    const other = await makeClient();

    await expect(
      personalities.attach(mine.id, other.personality.id, ['poached'], 'manual'),
    ).rejects.toThrow();
    expect(await prisma.person.count({ where: { personalityId: other.personality.id } })).toBe(0);
  });

  it('lists only the calling client s personalities', async () => {
    const mine = await makeClient();
    const other = await makeClient();

    const listed = await personalities.list(mine.id);
    const ids = listed.map((p) => p.id);
    expect(ids).toContain(mine.personality.id);
    expect(ids).not.toContain(other.personality.id);
  });
});

describe('invalid handles', () => {
  it('reports unparseable handles instead of dropping them', async () => {
    const client = await makeClient();
    const raw = [
      'good_handle',
      'ab', // under three characters
      '9starts_with_digit',
      'has space',
      'waytoolongforsnapchat',
      '@@@',
      '',
      'BigMike', // valid: normHandle casefolds before validating
    ];

    const result = await personalities.attach(client.id, client.personality.id, raw, 'manual');

    expect(result.added.sort()).toEqual(['bigmike', 'good_handle']);
    // Returned verbatim, so a client can see which of its 500 lines was noise.
    expect(result.invalid.sort()).toEqual(
      ['', '9starts_with_digit', '@@@', 'ab', 'has space', 'waytoolongforsnapchat'].sort(),
    );
    expect(await prisma.person.count({ where: { personalityId: client.personality.id } })).toBe(2);
  });

  it('truncates a pathologically long handle in the echo rather than reflecting it', async () => {
    const client = await makeClient();
    const noise = 'z'.repeat(5_000);

    const result = await personalities.attach(client.id, client.personality.id, [noise], 'manual');

    expect(result.added).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].length).toBeLessThanOrEqual(200);
  });
});
