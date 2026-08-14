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

import { NO_NATIONALITY } from '../../src/extraction/normalize';
import { avatarPrompt, sheetPrompt } from '../../src/extraction/sheet-task';
import { dropFixtures, makeClient, prisma } from '../fixtures';
import { GOLDEN_99, GOLDEN_99_RERUN, HAIKU_TWIN } from '../recorded';
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

/**
 * The client's ordered predicates. `presentsAs: []` and `countries: []` both
 * mean any -- and `countries: [NO_NATIONALITY]` means one narrow slice of it:
 * exactly the people whose nationality was never read. See normalize.ts, which
 * argues why that sentinel is spelled 'none' and not 'unknown'.
 */
async function rule(
  clientId: string,
  presentsAs: string[],
  opts: { countries?: string[]; minConfidence?: string } = {},
): Promise<void> {
  await prisma.filterRule.create({
    data: {
      clientId,
      position: 0,
      enabled: true,
      presentsAs,
      countries: opts.countries ?? [],
      minConfidence: opts.minConfidence ?? 'low',
      action: 'forward',
    },
  });
}

/** The handles this account was actually given work for, sorted. */
async function queued(accountId: string): Promise<string[]> {
  const rows = await prisma.assignment.findMany({
    where: { accountId },
    include: { person: { select: { handle: true } } },
  });
  return rows.map((r) => r.person.handle).sort();
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

describeSheet('a country the model returned that no list ever contained', () => {
  /**
   * `welsh` was unreachable, twice over.
   *
   * The rules screen offered a constant of 16 capitalised strings and `Welsh`
   * was not among them, so no checkbox could name it -- and PUT filtered the
   * submitted list against that same constant, so submitting it anyway saved a
   * rule WITHOUT it and answered `{ saved: true }`. In production the model had
   * put 19 people in that bucket. This reply puts 2 there, and they are the
   * whole point: a value that only exists because the model said it.
   *
   * Asserted as the exact handle set rather than a count, because the failure
   * this guards against is a rule that forwards the wrong two people just as
   * silently as one that forwards none.
   */
  it('is selectable, and forwards exactly the people in it', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    await rule(client.id, ['man'], { countries: ['welsh'] });
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99_RERUN);
    await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    // Stored lowercase -- normCountry folds case on the way in, which is why
    // the options endpoint serves lowercase and the rule above is typed that
    // way even though the model answered "Welsh".
    expect(
      await prisma.person.count({
        where: { personalityId: client.personality.id, nationality: 'welsh' },
      }),
    ).toBe(2);
    expect(await queued(account.id)).toEqual(['benlottablockz0', 'dylan91193']);
  });
});

describeSheet('the people whose nationality was never read', () => {
  /**
   * The second-largest bucket on the client that prompted this change -- 112
   * people -- and NOTHING could target them.
   *
   * normCountry maps 'unknown' to null, so they hold no value to match; the
   * filter required a non-null nationality before it compared anything, so they
   * fell out of every named rule; and the `unknown` checkbox the screen offered
   * was therefore inert. It looked like it worked, which is why it survived --
   * and why the sentinel below is spelled 'none' instead, so that the rules
   * still holding the old inert tick do not silently acquire this bucket.
   *
   * minConfidence is 'high' here on purpose. Every one of these entries came
   * back `low`, so the confidence gate would drop all six -- and would drop them
   * at the DEFAULT `low` bar too for any entry where the model omitted the field
   * entirely, since confidenceAtLeast ranks a null at 0. A floor on the quality
   * of a nationality reading cannot apply when there is no reading, and a
   * sentinel that works for some of the bucket depending on whether the model
   * attached a confidence to a non-answer is worse than one that never worked.
   */
  it('are matched by the sentinel, and nobody else is', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    await rule(client.id, [], { countries: [NO_NATIONALITY], minConfidence: 'high' });
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    // Exactly the six the model answered "unknown" for. The other 93 all carry
    // a reading, and a reading is never unread however weak it is -- that is
    // what minConfidence is for, and it is the distinction the sentinel would
    // destroy if it were implemented as "no reading matches anything".
    expect(await queued(account.id)).toEqual([
      'aj.ragan07',
      'btu1702',
      'freeboy3532',
      'fsec04',
      'mwf_636',
      'teejayk223',
    ]);

    // The reason is served to the machine on the claim and written into the CSV
    // export. Interpolating the null renders the literal text "man, null" to
    // whoever opens it -- invisible until now only because these people never
    // reached allocate.
    const reasons = await prisma.assignment.findMany({
      where: { accountId: account.id },
      select: { reason: true },
    });
    expect(reasons.every((r) => (r.reason ?? '').endsWith('no nationality read'))).toBe(true);
    expect(reasons.some((r) => (r.reason ?? '').includes('null'))).toBe(false);

    // And the gate still bites for people who DO have a reading. Replayed over
    // the stored rows rather than re-uploaded: the same free replay a rule
    // change gets in production. Every American entry here is `low`, so a high
    // bar forwards none of them -- proving the skip above is scoped to people
    // with nothing to grade and did not just switch the floor off.
    await prisma.filterRule.updateMany({
      where: { clientId: client.id },
      data: { countries: ['american'] },
    });
    const people = await prisma.person.findMany({
      where: { personalityId: client.personality.id },
      select: { id: true },
    });
    const replayed = await h.pipeline.filter(
      client.id,
      people.map((p) => p.id),
    );
    expect(replayed).toEqual([]);
  });

  it('compose with a real country in the same rule', async () => {
    // The operator ticks `italian` and `no nationality read`. Both populations
    // forward, and only those two -- the sentinel is one more member of the
    // same OR, which is also why it cannot collide with the empty list: "any"
    // is a property of the array's length, not of its contents.
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    await rule(client.id, [], { countries: ['italian', NO_NATIONALITY] });
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    expect(await queued(account.id)).toEqual([
      'aj.ragan07',
      'beastboyzz34',
      'btu1702',
      'freeboy3532',
      'fsec04',
      'gluca256432',
      'jquadef',
      'lorenzo_picen26',
      'lukatmeee',
      'matteosotgiu',
      'mwf_636',
      'teejayk223',
    ]);
  });

  it('are forwarded by the empty list too, which still means any', async () => {
    // The regression this change could most easily have caused. `countries: []`
    // is how every permissive baseline in the suite is spelled -- see
    // forwardEverything in e2e/app.ts -- and repurposing the empty list for the
    // sentinel would have silently narrowed all of them to the unread bucket.
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    await rule(client.id, [], { countries: [] });
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    // 99 read, one avatar/name disagreement dropped before any rule is
    // consulted, and the remaining 98 forwarded -- including the six with no
    // reading, which the empty list has always covered.
    const handles = await queued(account.id);
    expect(handles).toHaveLength(98);
    expect(handles).toContain('fsec04');
    expect(handles).not.toContain('kylee258082');
  });

  /**
   * Adding a checkbox must never widen a rule past "any", and this is the case
   * where it did.
   *
   * The first version of the confidence gate skipped the floor only when the
   * rule NAMED the sentinel, so at a `medium` or `high` bar the empty list
   * dropped every unread person while `['none']` forwarded all of them --
   * `countries: []` was a strict SUBSET of `countries: ['none']`. Both the PUT
   * note ("no countries selected: every origin is forwarded") and the Targeting
   * screen ("Nothing ticked forwards every origin") were false for the
   * second-largest bucket in the data. First-match-wins made it worse: an "any"
   * rule at position 0 broke on the gate and killed a following ['none'] rule
   * for the same person.
   *
   * Replayed over one upload rather than three, and asserted as a SET RELATION
   * rather than as counts, because the property is the relation. A future
   * change that moves people in or out of the golden sheet should not have to
   * touch this test to keep it meaningful.
   */
  it('keeps the empty list a superset of the sentinel at every floor', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    await rule(client.id, [], { countries: [], minConfidence: 'high' });
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    const people = await prisma.person.findMany({
      where: { personalityId: client.personality.id },
      select: { id: true },
    });
    const ids = people.map((p) => p.id);
    const replay = async (countries: string[]): Promise<Set<string>> => {
      await prisma.filterRule.updateMany({ where: { clientId: client.id }, data: { countries } });
      return new Set((await h.pipeline.filter(client.id, ids)).map((d) => d.personId));
    };

    for (const floor of ['low', 'medium', 'high']) {
      await prisma.filterRule.updateMany({
        where: { clientId: client.id },
        data: { minConfidence: floor },
      });
      const any = await replay([]);
      const sentinel = await replay([NO_NATIONALITY]);
      // Non-empty at every floor, or the assertion below would hold vacuously
      // and the whole test would pass on a filter that forwards nobody.
      expect(sentinel.size).toBe(6);
      for (const id of sentinel) expect(any.has(id)).toBe(true);
      expect(any.size).toBeGreaterThan(sentinel.size);
    }
  });

  /**
   * The deploy guard for the clients already out there.
   *
   * 'unknown' was in the deleted ORIGINS constant, the old screen rendered it
   * as a chip and the old PUT accepted it, so a saved rule can hold it today --
   * where it matches nobody, because the filter demanded a non-null nationality
   * before comparing. If the sentinel had been spelled 'unknown' too, this same
   * row would start forwarding the entire unread bucket the moment this deploys,
   * with nobody touching the screen: 112 people against 572 english on `kris
   * agency`, against a fixed dailyCapPerAccount. It must forward nobody.
   */
  it('leaves a rule still holding the legacy `unknown` tick forwarding nobody', async () => {
    const client = await makeClient({ accounts: 1, dailyCap: 50 });
    await rule(client.id, [], { countries: ['unknown'] });
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    expect(await queued(account.id)).toEqual([]);
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
