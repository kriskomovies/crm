/**
 * What the pipeline does when the model misbehaves -- through the real pipeline,
 * with replies real models really produced.
 *
 * These are the cases that decide whether the ledger can be trusted, and every
 * one of them is a thing that happened rather than a thing imagined: a model
 * that stopped reading pixels and described the same face 94 times, a reply cut
 * off by a token limit, four handles transcribed into something Snapchat cannot
 * hold, and one dropped character turning one man into two ledger rows.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';

import { isPlausibleHandle } from '../../src/extraction/normalize';
import { dropFixtures, makeClient, prisma, TestClient } from '../fixtures';
import {
  GOLDEN_99,
  HAIKU_TWIN,
  NANO_IMPLAUSIBLE,
  TEMPLATED_CUES,
  truncatedGolden,
  TRUNCATED_COMPLETE_ENTRIES,
} from '../recorded';
import { describeSheet, SHEET } from '../sheet-fixture';
import { bootHarness, forwardEverything, Harness } from './app';

let h: Harness;

beforeEach(async () => {
  h = await bootHarness();
});
afterEach(async () => {
  await h.close();
  await dropFixtures();
});

/**
 * A client whose extraction model is the one that produced the reply under test.
 *
 * Not cosmetic: the model name is what the cost row is priced against and what
 * is written to Extraction.model, so pairing a gpt-4.1-mini reply with a client
 * configured for gemini would record a bill nobody was ever sent.
 */
async function clientFor(model: string, accounts = 1): Promise<TestClient> {
  const client = await makeClient({ accounts, dailyCap: 50 });
  await forwardEverything(client.id);
  await prisma.client.update({ where: { id: client.id }, data: { extractionModel: model } });
  return client;
}

describeSheet('a templated reply is refused', () => {
  /**
   * The failure this guard exists for is not a crash. gpt-4.1-mini returned 99
   * well-formed entries with 99 usable handles and labelled every one of them
   * "man" off a single description it reused 94 times -- against an 88%-male
   * corpus that scores as success. Nothing downstream can tell such a reply from
   * a good one, so it has to be refused here or not at all.
   */
  it('rejects the sheet, records why, and creates nobody', async () => {
    const client = await clientFor('gpt-4.1-mini');
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(TEMPLATED_CUES);
    const upload = await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect(upload.status).toBe(202);

    const [run] = await h.drainQueue();
    // Thrown as UnrecoverableError so BullMQ stops instead of buying three more
    // vision calls to reach the same deterministic verdict.
    expect(run.error).not.toBeNull();
    expect(run.error!.message).toMatch(/templated/);
    expect(run.error!.constructor.name).toBe('UnrecoverableError');

    const status = await api.get(`/v1/accounts/${account.id}/sheets/${upload.body.jobId}`);
    // 'rejected', not 'failed'. They mean different things to whoever reads the
    // queue: failed invites a retry, rejected says the model is the problem.
    expect(status.body.status).toBe('rejected');
    expect(status.body.error).toMatch(/templated avatar descriptions/);
    // The measured ratio survives into the error text, so the number that
    // condemned the reply is visible without opening the extraction row.
    expect(status.body.error).toMatch(/0\.04/);

    // Not one person. The reply carried 99 perfectly good handles and the guard
    // refused all of them, which is the whole point.
    expect(await prisma.person.count({ where: { personalityId: client.personality.id } })).toBe(0);
    expect(
      await prisma.assignment.count({ where: { accountId: account.id } }),
    ).toBe(0);

    // The call still happened and was still billed. Rejecting the answer does
    // not refund it, and pretending otherwise would understate the cost of a
    // bad model exactly where that cost is being measured.
    const extraction = await prisma.extraction.findUniqueOrThrow({
      where: { sheetId: upload.body.jobId },
    });
    expect(extraction.profilesFound).toBe(99);
    expect(extraction.distinctCuesRatio).toBeCloseTo(0.0404, 4);
    expect(Number(extraction.usd)).toBeCloseTo(0.006111, 6);
    // Kept verbatim, so the reply can be re-parsed later without paying again.
    expect(extraction.rawReply).toBe(TEMPLATED_CUES.text);
  });
});

describeSheet('a truncated reply is salvaged', () => {
  it('marks the sheet partial and keeps every complete entry', async () => {
    const client = await clientFor('gemini-3.6-flash');
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(truncatedGolden());
    const upload = await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    const [run] = await h.drainQueue();
    expect(run.error).toBeNull();

    const status = await api.get(`/v1/accounts/${account.id}/sheets/${upload.body.jobId}`);
    // 'partial', not 'failed': 80 of 99 is worth having, and the operator needs
    // to know the sheet is short rather than believing it is complete.
    expect(status.body.status).toBe('partial');
    expect(status.body.profilesFound).toBe(TRUNCATED_COMPLETE_ENTRIES);
    expect(status.body.newPeople).toBe(TRUNCATED_COMPLETE_ENTRIES);

    const handles = (
      await prisma.person.findMany({
        where: { personalityId: client.personality.id },
        select: { handle: true },
      })
    ).map((p) => p.handle);
    expect(handles).toHaveLength(TRUNCATED_COMPLETE_ENTRIES);
    // The first entry survived and the one the cut landed inside did not: the
    // salvage keeps whole objects and never half-reads one.
    expect(handles).toContain('austingar_23');
    expect(handles).not.toContain('koyalkar_rakesh');
    // And the 80 it kept are the same 80 the untruncated reply would have given.
    const full = JSON.parse(GOLDEN_99.text).entries.slice(0, TRUNCATED_COMPLETE_ENTRIES);
    expect(handles.sort()).toEqual(full.map((e: any) => e.handle).sort());
  });
});

describeSheet('an implausible handle is skipped, the rest still land', () => {
  /**
   * An invented handle is far more damaging than a dropped one. It enters the
   * ledger, gets assigned, and an account spends a follow slot on somebody who
   * does not exist -- and nothing downstream can tell it was noise. So the four
   * gpt-5.4-nano could not read are dropped, loudly in the counts and silently
   * in the ledger, and its other 95 are kept.
   */
  it('keeps 95 of 99 and lets none of the four through', async () => {
    const client = await clientFor('gpt-5.4-nano');
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(NANO_IMPLAUSIBLE);
    const upload = await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    const [run] = await h.drainQueue();
    expect(run.error).toBeNull();

    const status = await api.get(`/v1/accounts/${account.id}/sheets/${upload.body.jobId}`);
    // The reply itself was complete -- 99 entries, nothing salvaged -- so the
    // sheet is 'extracted'. Dropped handles are a transcription problem, not a
    // truncation problem, and conflating them would hide which one happened.
    expect(status.body.status).toBe('extracted');
    expect(status.body.profilesFound).toBe(99);
    expect(status.body.newPeople).toBe(95);

    const handles = (
      await prisma.person.findMany({
        where: { personalityId: client.personality.id },
        select: { handle: true },
      })
    ).map((p) => p.handle);
    expect(handles).toHaveLength(95);
    // The four, exactly as the model wrote them: a space, sixteen characters,
    // an apostrophe, and nothing at all.
    for (const rejected of ['johnnywalker n', 'towmaterrrrrrrrr', "ifloyd1'112", '']) {
      expect(handles).not.toContain(rejected);
    }
    expect(handles.every(isPlausibleHandle)).toBe(true);
  });
});

describeSheet('a near duplicate goes to review, not to a second follow', () => {
  /**
   * Two independent extractions of ONE image read the same man as
   * `timetogotawatch` and `timetogotowatch`, both under the display name "Matt".
   * Left alone that is two ledger rows for one human and, if both match the
   * filter, two accounts told to follow him -- the exact duplicate this product
   * exists to prevent.
   *
   * It is NOT auto-merged, and that restraint is the point: `kadenm_o6` and
   * `kadenm_06` are also one character apart and are plausibly two real people,
   * o/0 being the hardest glyph in this font. So a human decides.
   */
  it('flags the twin with a reason naming it, and leaves the original queued', async () => {
    const client = await clientFor('gemini-3.6-flash', 2);
    const [first, second] = client.personality.accounts;
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    const one = await api.upload(`/v1/accounts/${first.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    // The same screenshot, read again by a different model on a sibling account.
    h.gateway.script(HAIKU_TWIN);
    const two = await api.upload(`/v1/accounts/${second.id}/sheets`, SHEET);
    expect(one.body.jobId).not.toBe(two.body.jobId);
    expect((await h.drainQueue())[0].error).toBeNull();

    const twin = await prisma.assignment.findFirstOrThrow({
      where: { person: { personalityId: client.personality.id, handle: 'timetogotowatch' } },
    });
    expect(twin.state).toBe('review');
    // The reason names the handle it looks like, so the human reviewing it does
    // not have to search the ledger to find out what the machine meant.
    expect(twin.reason).toContain('@timetogotawatch');

    // The original is untouched and still work for the account that found it.
    const original = await prisma.assignment.findFirstOrThrow({
      where: { person: { personalityId: client.personality.id, handle: 'timetogotawatch' } },
    });
    expect(original.state).toBe('queued');
    expect(original.accountId).toBe(first.id);

    // The second read introduced 43 handles the first did not have, and 12 of
    // them are one character from a handle already in the ledger under the same
    // display name. All 12 are held; the other 31 are work.
    expect(await prisma.assignment.count({ where: { accountId: second.id } })).toBe(43);
    expect(
      await prisma.assignment.count({ where: { accountId: second.id, state: 'review' } }),
    ).toBe(12);
    expect(
      await prisma.assignment.count({ where: { accountId: second.id, state: 'queued' } }),
    ).toBe(31);
  });
});

describeSheet('re-uploading the same image is free', () => {
  /**
   * A client whose connection dropped retries. UNIQUE (accountId, sha256) means
   * the retry hands back the original job instead of buying a second vision
   * call, which at $0.08 a sheet is the difference between a retry and a bill.
   */
  it('returns the original job and does not extract or charge twice', async () => {
    const client = await clientFor('gemini-3.6-flash');
    const account = client.personality.accounts[0];
    const api = h.api(client.apiKey);

    h.gateway.script(GOLDEN_99);
    const first = await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect((await h.drainQueue())[0].error).toBeNull();

    // No second reply is scripted. If the pipeline ran again the fake gateway
    // would throw rather than quietly invent one, so this cannot pass by luck.
    const again = await api.upload(`/v1/accounts/${account.id}/sheets`, SHEET);
    expect(again.status).toBe(202);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.jobId).toBe(first.body.jobId);
    // The status of the job it already has, not 'received' all over again.
    expect(again.body.status).toBe('extracted');

    // Nothing was enqueued the second time, so no worker will pick it up.
    expect(h.queue.jobs).toHaveLength(1);
    expect(await h.drainQueue()).toEqual([]);

    expect(await prisma.sheet.count({ where: { accountId: account.id } })).toBe(1);
    expect(
      await prisma.extraction.count({ where: { sheet: { accountId: account.id } } }),
    ).toBe(1);
    expect(h.gateway.calls).toHaveLength(1);
    expect(await prisma.person.count({ where: { personalityId: client.personality.id } })).toBe(99);
  });
});
