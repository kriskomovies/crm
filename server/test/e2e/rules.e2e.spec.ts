/**
 * What reaches the queue and what is dropped.
 *
 * The journey test uses a rule that forwards everything, which is the right
 * baseline and also the kindest possible configuration. This file runs the same
 * real replies through the configurations a client actually arrives in -- no
 * rules yet, or a narrow rule -- because the interesting failures here are
 * silent ones. Nothing throws, no sheet is marked failed, and the ledger fills
 * up correctly; it is the work that goes missing.
 *
 * Since there is no review state, every drop is silent by construction: the
 * only trace is the absence of an assignment row. That makes the assertions
 * here about ABSENCE the load-bearing ones.
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
   * failed and nothing says why.
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
    // No assignments at all. An unconfigured client produces no decisions: the
    // avatar/name disagreement is dropped before any rule is consulted, and the
    // other 98 fall through an empty rule list. Both outcomes look the same
    // from here, which is the point of this test.
    expect(await prisma.assignment.count({ where: { accountId: account.id } })).toBe(0);

    const claim = await api.get(`/v1/accounts/${account.id}/targets`);
    expect(claim.body.targets).toEqual([]);
    // Neither budget is touched, and that is the tell: this is "no work
    // exists", not "you have spent today" and not "this window is full". The
    // three used to be indistinguishable from here, which is what the second
    // number fixed -- an empty list means something different in each case and
    // a client backs off differently for each.
    expect(claim.body.remainingToday).toBe(50);
    expect(claim.body.remainingInWindow).toBe(2000);
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
   * The near-duplicate verdict has to outlive the run that computed it.
   *
   * `resolve` finds the duplicate: claude-haiku reads entry 41 as
   * `timetogotowatch` where the golden run reads `timetogotawatch`, both named
   * "Matt". But this client forwards men, which is the normal configuration,
   * and claude-haiku's reply carries no avatar or name reading at all -- so all
   * 43 of its new people combine to "ambiguous", match no rule, and get no
   * decision. The twin is dropped for a reason that has nothing to do with
   * being a twin.
   *
   * That is the case where a verdict held only in memory disappears without
   * anyone noticing, because the visible outcome -- no assignment row -- is
   * identical either way. It stops being identical the moment the client widens
   * its rules, which the pipeline documents as a free replay of `filter` and
   * `allocate` over stored people. If the verdict did not survive, that replay
   * queues both rows and one man is followed twice; UNIQUE (personId) cannot
   * help, because they are two distinct Person rows, which is exactly what the
   * guard had noticed.
   *
   * So this asserts the column, and then asserts the replay.
   */
  it('is dropped, and stays dropped when the rules widen', async () => {
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

    // Dropped, and the reason is on the row rather than in a log line.
    expect(twin.assignment).toBeNull();
    expect(twin.nearDuplicateOf).toBe('timetogotawatch');

    // Now the client widens to anyone, and the stored people are re-decided
    // without another vision call. This is the free replay the pipeline is
    // built around, and the moment the old in-memory verdict would have been
    // gone.
    await prisma.filterRule.updateMany({
      where: { clientId: client.id },
      data: { presentsAs: [] },
    });
    const people = await prisma.person.findMany({
      where: { personalityId: client.personality.id },
      select: { id: true },
    });
    const replayed = await h.pipeline.filter(
      client.id,
      people.map((p) => p.id),
    );
    await h.pipeline.allocate(second.id, replayed);

    // The widened rule matched the twin on every predicate it has. The column
    // is what kept it out.
    expect(replayed.map((d) => d.personId)).not.toContain(twin.id);
    expect(
      await prisma.assignment.count({ where: { personId: twin.id } }),
    ).toBe(0);
    // And the man himself is still followed exactly once, by the account that
    // found him first. Scoped to this personality: another spec runs the same
    // two recorded replies in a parallel worker, and an unscoped query on the
    // handle sees its rows too.
    const assignments = await prisma.assignment.findMany({
      where: {
        person: {
          personalityId: client.personality.id,
          handle: { in: ['timetogotawatch', 'timetogotowatch'] },
        },
      },
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].accountId).toBe(first.id);
  });
});
