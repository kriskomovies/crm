/**
 * What reaches the queue, what reaches the review screen, and what reaches
 * neither.
 *
 * The journey test uses a rule that forwards everything, which is the right
 * baseline and also the kindest possible configuration. This file runs the same
 * real replies through the configurations a client actually arrives in -- no
 * rules yet, or a narrow rule -- because the interesting failures here are
 * silent ones. Nothing throws, no sheet is marked failed, and the ledger fills
 * up correctly; it is the work that goes missing.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';

import { avatarPrompt, sheetPrompt } from '../../src/extraction/sheet-task';
import { dropFixtures, makeClient, prisma } from '../fixtures';
import { GOLDEN_99, HAIKU_TWIN } from '../recorded';
import { describeSheet, SHEET } from '../sheet-fixture';
import { bootHarness, Harness } from './app';

let h: Harness;

beforeEach(async () => {
  h = await bootHarness();
});
afterEach(async () => {
  await h.close();
  await dropFixtures();
});

/** The client's ordered predicates. `presentsAs: []` means any. */
async function rule(clientId: string, presentsAs: string[]): Promise<void> {
  await prisma.filterRule.create({
    data: {
      clientId,
      position: 0,
      enabled: true,
      presentsAs,
      countries: [],
      minConfidence: 'low',
      action: 'forward',
    },
  });
}

describeSheet('a client with no filter rules', () => {
  /**
   * Documents current behaviour, and it is worth documenting because it is
   * indistinguishable from a broken pipeline at the only place a client can see:
   * the sheet status says the extraction succeeded and found 99 new people, and
   * the handout then answers with an empty page and a full cap. Nothing is
   * failed, nothing is held, and nothing says why.
   *
   * `filter` loops over the rule list, and an empty list means the loop body
   * never runs, so no decision is produced and `allocate` is handed nothing.
   */
  it('gets a full ledger and no work, with nothing to say why', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    const upload = await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    const status = await api.get(`/v1/accounts/${account.id}/sheets/${upload.body.jobId}`);
    expect(status.body).toMatchObject({ status: 'extracted', newPeople: 99, queued: 0 });

    expect(await prisma.person.count({ where: { personalityId: client.personality.id } })).toBe(99);
    // Exactly one assignment, and it is not a forward: the avatar/name
    // disagreement is held for review BEFORE any rule is consulted, so it is
    // the only decision an unconfigured client produces.
    const assignments = await prisma.assignment.findMany({ where: { accountId: account.id } });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].state).toBe('review');

    const claim = await api.get(`/v1/accounts/${account.id}/targets`);
    expect(claim.body.targets).toEqual([]);
    // The cap is untouched, which is the tell: this is "no work exists", not
    // "you have spent today". A client cannot distinguish the two from here.
    expect(claim.body.remainingToday).toBe(50);
  });
});

describeSheet('the templated-output guard', () => {
  /**
   * The guard is real and it works -- see pipeline-edges, where a templated
   * reply is refused. It just cannot be reached by anything the service asks
   * for.
   *
   * `distinctCuesRatio` reads `cues` off each entry. `cues` is requested by
   * `avatarPrompt`, and `avatarPrompt` is called from nowhere: the pipeline
   * makes one call, with `sheetPrompt`, whose JSON shape has no `cues` field.
   * So the ratio is null for every reply the shipped prompt elicits, `templated`
   * is false, and the sheet is accepted however many faces the model described
   * with one sentence.
   *
   * This is not a hypothesis about the code. Both real extractions in the dev
   * database -- gemini-3.6-flash over this same image -- have
   * distinctCuesRatio NULL, and so does the one below.
   */
  it('never sees a cue, because the shipped prompt does not ask for one', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    await rule(client.id, []);
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    const upload = await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    const extraction = await prisma.extraction.findUniqueOrThrow({
      where: { sheetId: upload.body.jobId },
    });
    expect(extraction.profilesFound).toBe(99);
    // Nothing to measure, so nothing was measured, so nothing can be refused.
    expect(extraction.distinctCuesRatio).toBeNull();

    // Where that null comes from. Kept here rather than in a unit test because
    // the point is the pairing: this prompt produces replies the guard above
    // cannot judge.
    expect(sheetPrompt(99)).not.toContain('cues');
    expect(avatarPrompt(99, 3)).toContain('cues');
  });
});

describeSheet('a near duplicate under a rule that does not match it', () => {
  /**
   * FAILING, and it is a real bug rather than a strict test.
   *
   * `resolve` finds the near duplicate correctly: claude-haiku reads entry 41 as
   * `timetogotowatch` where the golden run reads `timetogotawatch`, both named
   * "Matt", and the guard spots it. `run` then applies the verdict by walking
   * the DECISIONS the filter produced and overriding any that belong to a
   * flagged person -- so a person the filter produced no decision for is never
   * visited, and the verdict is dropped on the floor.
   *
   * That is easy to hit. This client forwards men, which is the normal
   * configuration; claude-haiku's sheet reply carries no avatar or name reading
   * at all, so all 43 of its new people combine to "ambiguous", match no rule,
   * and get no decision. The twin is therefore stored, flagged, and then
   * silently forgotten: no assignment row, absent from the queue, absent from
   * the review screen, and no human is ever asked the question the guard exists
   * to raise.
   *
   * Why it matters beyond the missing review item: the verdict is computed in
   * `resolve` and never persisted -- Person has no near-duplicate column -- so
   * nothing can recover it later. The moment this client widens its rules, which
   * the pipeline documents as a free replay of `filter` and `allocate` over
   * stored people, both rows are queued and the same man is followed twice. The
   * unique constraint cannot help: they are two different people as far as the
   * database is concerned, which is exactly what the guard had noticed.
   *
   * The pipeline's own comment states the intended rule -- "A near duplicate
   * never goes straight out, whatever the rules say" -- so this asserts that.
   */
  it('is held for review, not dropped', async () => {
    const client = await makeClient({ accounts: 2, dailyCap: 50 });
    await rule(client.id, ['man']);
    const [first, second] = client.personality.accounts;
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    await api.upload(`/v1/accounts/${first.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    h.gateway.script(HAIKU_TWIN);
    await api.upload(`/v1/accounts/${second.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    // The guard did its job: two rows for one man, one character apart, same
    // display name, and the pipeline knew it at insert time.
    const twin = await prisma.person.findFirstOrThrow({
      where: { personalityId: client.personality.id, handle: 'timetogotowatch' },
      include: { assignment: true },
    });
    const original = await prisma.person.findFirstOrThrow({
      where: { personalityId: client.personality.id, handle: 'timetogotawatch' },
      include: { assignment: true },
    });
    expect(twin.displayName).toBe(original.displayName);
    expect(original.assignment!.state).toBe('queued');

    // What should have happened to the one it was suspicious of.
    expect(twin.assignment).not.toBeNull();
    expect(twin.assignment!.state).toBe('review');
    expect(twin.assignment!.reason).toContain('@timetogotawatch');

    // And the human has to be able to find it. This is the screen that decides
    // whether the near-duplicate guard is a feature or a comment.
    const review = await api.get(`/api/personalities/${client.personality.id}/review`);
    expect(review.status).toBe(200);
    expect(review.body.items.map((i: any) => i.handle)).toContain('timetogotowatch');
  });
});
