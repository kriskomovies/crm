/**
 * The journey: a screenshot goes in over HTTP and follow targets come back out.
 *
 * Everything the product does happens in this one test, in order, against the
 * real image, the real ledger and a recorded reply that is known to be perfect.
 * The interesting assertions are not that it runs -- they are the three the
 * business is sold on:
 *
 *   c) the 99 handles that come out equal the 99 in vlm_eval/ground_truth.json.
 *      That key was built by reading pixels at high zoom, so this is a GOLDEN
 *      FILE test: normalisation, the handle regex, the parser and the dedupe key
 *      are all pinned to a known-right answer, and drift in any of them shows up
 *      as a diff against the key rather than as a count that quietly moved.
 *
 *   d) the same sheet on a SECOND account of the same personality adds nobody
 *      and assigns nobody. That is the dedupe ledger -- the thing that stops two
 *      of kris's accounts following one person twice.
 *
 *   e) the same sheet on a DIFFERENT personality creates its own 99. Two
 *      personalities holding one handle is required, not tolerated; if this ever
 *      goes red because someone made the unique global, the second personality
 *      would silently stop growing in production and nothing would error.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addPersonality, dropFixtures, makeClient, prisma } from '../fixtures';
import { GOLDEN_99, GOLDEN_99_RERUN, groundTruthHandles, SHEET_SHA256 } from '../recorded';
import { bootHarness, forwardEverything, Harness } from './app';

/** The real screenshot, all 99 profiles of it. */
const SHEET = readFileSync(join(__dirname, '..', '..', '..', 'test', 'main', 'all99_3col.png'));

/**
 * The one entry in the golden reply whose avatar and display name disagree:
 * the cartoon reads man, the name reads woman. `filter` holds it for review
 * before it consults any rule, which is the guard that keeps a woman out of a
 * client's men-only feed -- and the reason avatar and name are asked for
 * separately in the first place.
 */
const DISAGREEING_HANDLE = 'kylee258082';

let h: Harness;

// A fresh application per test. Booting AppModule is under a second, and a
// shared harness would carry one test's scripted replies and enqueued jobs into
// the next -- which is exactly the cross-test dependency these tests must not
// have.
beforeEach(async () => {
  h = await bootHarness();
});
afterEach(async () => {
  await h.close();
  await dropFixtures();
});

describe('screenshot to follow targets, over HTTP', () => {
  it('walks the whole journey', async () => {
    const client = await makeClient({ accounts: 2, dailyCap: 10 });
    await forwardEverything(client.id);
    const kris = client.personality;
    const [first, second] = kris.accounts;
    const api = h.api(client.apiKey);

    // The guard is not bypassed anywhere in this suite, so prove it is on.
    const forged = await h
      .api(client.apiKey)
      .withKey('not-a-real-key')
      .upload(`/v1/accounts/${first.id}/sheets`, SHEET);
    expect(forged.status).toBe(401);

    // (a) upload the real image as multipart -> 202 and a job id
    h.gateway.script(GOLDEN_99);
    const upload = await api.upload(`/v1/accounts/${first.id}/sheets`, SHEET);
    expect(upload.status).toBe(202);
    expect(upload.body.duplicate).toBe(false);
    expect(upload.body.status).toBe('received');
    const jobId: string = upload.body.jobId;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    // Content-addressed, so the ingest hashed the bytes it was actually sent.
    const sheetRow = await prisma.sheet.findUniqueOrThrow({ where: { id: jobId } });
    expect(sheetRow.sha256).toBe(SHEET_SHA256);

    // The contract the worker consumes. Everything past this point is stubbed
    // -- see the header of test/e2e/app.ts for what that leaves uncovered.
    expect(h.queue.jobs).toEqual([
      { name: 'extract', data: { sheetId: jobId }, opts: { jobId } },
    ]);

    // (b) drive the extraction with the recorded 99/99 reply
    const [run] = await h.drainQueue();
    expect(run.error).toBeNull();

    // The pipeline read the image back out of storage and sent those bytes, not
    // a placeholder: if the storage round trip were broken this is where it
    // would show, rather than as a mysteriously empty extraction.
    expect(h.gateway.calls).toHaveLength(1);
    expect(h.gateway.calls[0]).toMatchObject({
      model: 'gemini-3.6-flash',
      imageBytes: SHEET.length,
      imageMime: 'image/png',
    });

    // (c) THE GOLDEN ASSERTION: 99 people, and they are the right 99.
    const people = await prisma.person.findMany({
      where: { personalityId: kris.id },
      select: { handle: true, timesSeen: true, firstSeenSheetId: true },
    });
    expect(people).toHaveLength(99);
    expect(people.map((p) => p.handle).sort()).toEqual(groundTruthHandles());
    expect(people.every((p) => p.firstSeenSheetId === jobId)).toBe(true);

    // Reported back over HTTP too, so the number the client polls is the same
    // number the ledger holds.
    const status = await api.get(`/v1/accounts/${first.id}/sheets/${jobId}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      jobId,
      status: 'extracted',
      error: null,
      profilesFound: 99,
      newPeople: 99,
      queued: 98,
    });
    // A number, not the string a Prisma Decimal serialises to. 1718 prompt and
    // 13125 completion tokens at the measured gemini-3.6-flash price.
    expect(typeof status.body.costUsd).toBe('number');
    expect(status.body.costUsd).toBeCloseTo(0.082209, 6);

    // 98 forwarded, and the one the avatar and the name disagreed about held.
    const held = await prisma.assignment.findFirstOrThrow({
      where: { person: { personalityId: kris.id, handle: DISAGREEING_HANDLE } },
    });
    expect(held.state).toBe('review');
    expect(held.reason).toBe('avatar reads man, name reads woman');
    expect(
      await prisma.assignment.count({ where: { accountId: first.id, state: 'queued' } }),
    ).toBe(98);
    expect(
      await prisma.assignment.count({ where: { accountId: first.id, state: 'review' } }),
    ).toBe(1);

    // (d) the same sheet on a SIBLING account: nobody new, nothing assigned.
    // Scripted with the SECOND real run over this image rather than a replay of
    // the first -- it agrees on all 99 handles and differs on 8 display names,
    // which is what re-reading a screenshot really looks like.
    h.gateway.script(GOLDEN_99_RERUN);
    const sibling = await api.upload(`/v1/accounts/${second.id}/sheets`, SHEET);
    expect(sibling.status).toBe(202);
    // A different account, so not a duplicate upload: the hash is unique per
    // account. It costs a second extraction and dedupes in the ledger instead.
    expect(sibling.body.duplicate).toBe(false);
    const [siblingRun] = await h.drainQueue();
    expect(siblingRun.error).toBeNull();

    expect(await prisma.person.count({ where: { personalityId: kris.id } })).toBe(99);
    expect(await prisma.assignment.count({ where: { accountId: second.id } })).toBe(0);
    // Seen twice, still one row.
    const seenTwice = await prisma.person.findMany({
      where: { personalityId: kris.id },
      select: { timesSeen: true },
    });
    expect(new Set(seenTwice.map((p) => p.timesSeen))).toEqual(new Set([2]));

    // (e) a DIFFERENT personality gets its own 99 and its own assignments.
    const mia = await addPersonality(client.id, { accounts: 1, dailyCap: 10 });
    h.gateway.script(GOLDEN_99);
    const other = await api.upload(`/v1/accounts/${mia.accounts[0].id}/sheets`, SHEET);
    expect(other.status).toBe(202);
    const [otherRun] = await h.drainQueue();
    expect(otherRun.error).toBeNull();

    expect(await prisma.person.count({ where: { personalityId: mia.id } })).toBe(99);
    expect(await prisma.assignment.count({ where: { accountId: mia.accounts[0].id } })).toBe(99);
    // One handle, two rows, one per personality. A global unique would have
    // made the second of these silently impossible.
    expect(
      await prisma.person.count({
        where: { handle: DISAGREEING_HANDLE, personalityId: { in: [kris.id, mia.id] } },
      }),
    ).toBe(2);

    // (f) the handout is metered by dailyCap, which is 10 here against 98 queued
    const claim = await api.get(`/v1/accounts/${first.id}/targets`);
    expect(claim.status).toBe(200);
    expect(claim.body.targets).toHaveLength(10);
    expect(claim.body.remainingToday).toBe(0);
    // Real rows, joined to the person: a handle, a name and why it was chosen.
    expect(claim.body.targets[0]).toEqual({
      handle: expect.any(String),
      displayName: expect.any(String),
      nationality: expect.anything(),
      reason: expect.any(String),
    });
    expect(groundTruthHandles()).toContain(claim.body.targets[0].handle);
    // The held-for-review one is not work, and must never be handed out.
    expect(claim.body.targets.map((t: any) => t.handle)).not.toContain(DISAGREEING_HANDLE);

    // Spent. The cap is the only thing protecting the Snapchat account from
    // rate limiting, so an exhausted account gets an empty page, not more work.
    const again = await api.get(`/v1/accounts/${first.id}/targets`);
    expect(again.body.targets).toEqual([]);

    // (g) report results back
    const [followedTarget, failedTarget] = claim.body.targets;

    const ok = await api.post(
      `/v1/accounts/${first.id}/targets/${followedTarget.handle}/result`,
      { result: 'followed' },
    );
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ ok: true });
    const followedRow = await prisma.assignment.findFirstOrThrow({
      where: { person: { personalityId: kris.id, handle: followedTarget.handle } },
    });
    expect(followedRow.state).toBe('followed');
    expect(followedRow.resultAt).not.toBeNull();

    // A failure returns to the queue -- it is retried, not lost -- but keeps
    // handedOutAt, so the attempt still counts against today.
    const failed = await api.post(
      `/v1/accounts/${first.id}/targets/${failedTarget.handle}/result`,
      { result: 'failed', note: 'rate limited by the app' },
    );
    expect(failed.status).toBe(201);
    const failedRow = await prisma.assignment.findFirstOrThrow({
      where: { person: { personalityId: kris.id, handle: failedTarget.handle } },
    });
    expect(failedRow.state).toBe('queued');
    expect(failedRow.handedOutAt).not.toBeNull();
    expect(failedRow.note).toBe('rate limited by the app');

    // The global pipe is real: a result outside the enum never reaches the
    // service, so the ledger cannot be moved into a state nothing reads.
    const nonsense = await api.post(
      `/v1/accounts/${first.id}/targets/${failedTarget.handle}/result`,
      { result: 'exploded' },
    );
    expect(nonsense.status).toBe(400);
  });
});
