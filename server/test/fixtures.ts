/**
 * Isolated fixtures for the integration suite.
 *
 * Every test builds its own client, so nothing it does can be seen by another
 * test and nothing another test does can be seen by it. Order does not matter
 * and a crashed test leaves at most one client behind rather than a half-edited
 * shared personality. Cleanup is a single delete of the client: the schema
 * cascades from there through personalities, accounts, people and assignments.
 *
 * Services are constructed by hand rather than through Nest's DI container.
 * Booting AppModule pulls in BullModule, which opens a Redis connection, and
 * this machine has no Redis -- the suite would fail on infrastructure it does
 * not test. Constructing three objects is also honest about what is under test.
 */
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { ONBOARD_TARGET } from '../src/onboarding/onboarding.service';
import { hashApiKey } from '../src/auth/api-key.guard';
import { GatewayClient } from '../src/extraction/gateway.client';
import { PersonalitiesService } from '../src/personalities/personalities.service';
import { PipelineService } from '../src/pipeline/pipeline.service';
import { RetentionService } from '../src/retention/retention.service';
import { StorageService } from '../src/storage/storage.service';
import { TargetsService } from '../src/targets/targets.service';

export const prisma = new PrismaClient();

// `as any` for the client, as scripts/demo.ts does: PrismaService adds only
// Nest lifecycle hooks to PrismaClient, and there is no Nest lifecycle here.
const storage = new StorageService();
// Constructed but never started: onModuleInit is what arms the sweep timer, and
// Nest is not running it here. The request-driven paths -- the delete after the
// pipeline commits, and the purge before a personality cascade -- work without
// it, which is exactly what these fixtures exercise.
const retention = new RetentionService(prisma as any, storage);
const pipeline = new PipelineService(prisma as any, storage, new GatewayClient(), retention);
export const personalities = new PersonalitiesService(prisma as any, pipeline, retention);
export const targets = new TargetsService(prisma as any);

export interface TestAccount {
  id: string;
  label: string;
  /** The client's cap, echoed here so handout tests can assert against it. */
  dailyCap: number;
}

export interface TestPersonality {
  id: string;
  name: string;
  accounts: TestAccount[];
}

export interface TestClient {
  id: string;
  name: string;
  /** The plaintext key; only its hash is stored. Needed to reach /api over HTTP. */
  apiKey: string;
  personality: TestPersonality;
}

interface FixtureOptions {
  /** Enabled accounts to create. Use 1 when a test needs every target on one. */
  accounts?: number;
  dailyCap?: number;
  /** Targets per account per rolling window. Left wide open unless a test says. */
  sessionCap?: number;
  /** How long that window is, in minutes. */
  sessionWindow?: number;
  /** The two caps that REPLACE the pair above while an account is ONBOARDING. */
  onboardingDailyCap?: number;
  onboardingSessionCap?: number;
  /** Create the accounts as still onboarding. Default FALSE -- see accountData:
   *  a test that says `dailyCap: 7` means "an account capped at 7", and an
   *  onboarding account is not metered by that number at all. */
  onboarding?: boolean;
  /** Which VLM the pipeline is told to use. Pinned unless a test says. */
  model?: string;
}

/** Clients this run created, so afterEach can drop exactly those and no others. */
const created: string[] = [];

/**
 * `dailyCap` is a CLIENT setting now, not a column here, so the fixtures set it
 * on the client and echo it onto each TestAccount. Tests that say
 * `makeClient({ dailyCap: 7 })` still read as "an account capped at 7", which
 * is the property they were written to check.
 */
function accountData(name: string, opts: FixtureOptions) {
  const count = opts.accounts ?? 1;
  // ESTABLISHED unless a test asks otherwise. A fresh row would default to
  // onboardedCount 0, which is "still onboarding" -- and an onboarding account
  // is metered by onboardingDailyCap/onboardingSessionCap, NOT by the dailyCap
  // the test set. Every cap test here was written to mean "an account capped at
  // N", so the fixture has to produce the kind of account that number applies
  // to. Tests about onboarding pass `onboarding: true` and say so.
  const onboardedCount = opts.onboarding ? 0 : ONBOARD_TARGET;
  return Array.from({ length: count }, (_, i) => ({
    label: `${name}_snap_${String(i + 1).padStart(2, '0')}`,
    onboardedCount,
  }));
}

export async function makeClient(opts: FixtureOptions = {}): Promise<TestClient> {
  const tag = randomUUID();
  const name = `kris-${tag.slice(0, 8)}`;
  const apiKey = `int-key-${tag}`;
  const row = await prisma.client.create({
    data: {
      // The "int " prefix makes a leaked fixture obvious in psql; the uuid is
      // what actually keeps concurrent runs from colliding on apiKeyHash.
      name: `int ${tag}`,
      apiKeyHash: hashApiKey(apiKey),
      // The suite predates the global cap and assumes 50 in a lot of places, so
      // that stays the fixture default. The PRODUCT default is 240 and is
      // asserted where it belongs, on the schema, not implied here.
      dailyCapPerAccount: opts.dailyCap ?? 50,
      // Wide open by default, and that is not laziness. The PRODUCT default is
      // 40 in a 60-minute window, which is below the cap several of these tests
      // deliberately claim in one go -- the concurrency tests take 50 rows at
      // dailyCap 200. Shipping the product default here would make them fail on
      // the session cap, a limit they were not written to measure, and the
      // failure would read as a broken claim. Tests about the session cap pass
      // sessionCap explicitly, exactly as cap tests pass dailyCap.
      sessionCapPerAccount: opts.sessionCap ?? 2000,
      // Wide open by default and NOT mirroring the pair above, deliberately: a
      // fixture account has onboardedCount 0, so it is "onboarding" and every
      // pre-existing cap test would suddenly be metered by a number it never
      // set. Left at 2000 these are inert unless a test asks for them.
      // Mirror the ordinary caps by default: a test that says `onboarding: true`
      // and `dailyCap: 7` still means "capped at 7", without having to restate
      // the number twice.
      onboardingDailyCap: opts.onboardingDailyCap ?? opts.dailyCap ?? 50,
      onboardingSessionCap: opts.onboardingSessionCap ?? opts.sessionCap ?? 2000,
      sessionWindowMinutes: opts.sessionWindow ?? 60,
      // Pinned for the same reason the caps are: the e2e suite replays a
      // recorded reply and asserts the dollar figure it costs, and both are
      // keyed to this model. Taking the schema default here would make those
      // tests fail whenever the product's default model changes, as a wrong
      // cost rather than as a changed default -- and the default itself is
      // asserted where it belongs, in defaults.int.spec.ts.
      extractionModel: opts.model ?? 'gemini-3.6-flash',
      personalities: { create: { name, accounts: { create: accountData(name, opts) } } },
    },
    include: { personalities: { include: { accounts: { orderBy: { label: 'asc' } } } } },
  });
  created.push(row.id);
  const p = row.personalities[0];
  return {
    id: row.id,
    name: row.name,
    apiKey,
    personality: {
      id: p.id,
      name: p.name,
      accounts: p.accounts.map((a) => ({
        id: a.id,
        label: a.label,
        dailyCap: row.dailyCapPerAccount,
      })),
    },
  };
}

/** A second personality under the same client -- the kris-and-mia case. */
export async function addPersonality(
  clientId: string,
  opts: FixtureOptions = {},
): Promise<TestPersonality> {
  const name = `mia-${randomUUID().slice(0, 8)}`;
  const p = await prisma.personality.create({
    data: { clientId, name, accounts: { create: accountData(name, opts) } },
    include: { accounts: { orderBy: { label: 'asc' } }, client: true },
  });
  // opts.dailyCap is ignored here on purpose: a second personality belongs to a
  // client that already has a cap, and a per-personality cap is exactly the
  // thing this change removed. Tests get the client's.
  return {
    id: p.id,
    name: p.name,
    accounts: p.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      dailyCap: p.client.dailyCapPerAccount,
    })),
  };
}

export async function dropFixtures(): Promise<void> {
  const ids = created.splice(0);
  if (ids.length === 0) return;
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Write people straight into the ledger, bypassing attach().
 *
 * The handout and pagination tests are about TargetsService and the cursor, not
 * about how rows got there; going through attach() would make them fail for
 * reasons that belong to another test. Handles stay inside the plausible shape
 * so the rows are indistinguishable from real ones.
 */
export async function addPeople(
  personalityId: string,
  count: number,
  prefix = 'walker',
): Promise<string[]> {
  const handles = Array.from({ length: count }, (_, i) => `${prefix}_${i}`);
  await prisma.person.createMany({
    data: handles.map((handle, i) => ({
      personalityId,
      handle,
      displayName: `Walker ${i}`,
    })),
  });
  return handles;
}

/**
 * People with a nationality each, written straight into the ledger.
 *
 * `null` is a bucket like any other here, and it is the one that matters: it is
 * what normCountry stores for every non-answer, so it is what the rules screen
 * has to be able to count and target. Buckets rather than a flat count because
 * the thing under test is the distribution -- "welsh 2, english 3, unread 4" is
 * the shape /api/rules serves back as its option list.
 */
export async function addPeopleByNationality(
  personalityId: string,
  buckets: { nationality: string | null; count: number }[],
): Promise<void> {
  const rows: {
    personalityId: string;
    handle: string;
    displayName: string;
    nationality: string | null;
  }[] = [];
  for (const b of buckets) {
    // The handle carries the bucket so a failure names the row that caused it,
    // and stays inside the plausible shape so the rows look like real ones.
    const tag = (b.nationality ?? 'unread').replace(/[^a-z]/g, '') || 'unread';
    for (let i = 0; i < b.count; i++) {
      rows.push({
        personalityId,
        handle: `${tag}_${i}`.slice(0, 15),
        displayName: `${tag} ${i}`,
        nationality: b.nationality,
      });
    }
  }
  await prisma.person.createMany({ data: rows });
}

/** People plus a queued assignment each, oldest first, all on one account. */
export async function queueTargets(
  personalityId: string,
  accountId: string,
  count: number,
  prefix = 'walker',
): Promise<string[]> {
  const handles = await addPeople(personalityId, count, prefix);
  const people = await prisma.person.findMany({
    where: { personalityId, handle: { in: handles } },
    select: { id: true, handle: true },
  });
  const order = new Map(handles.map((h, i) => [h, i]));
  await prisma.assignment.createMany({
    data: people.map((p) => ({
      personId: p.id,
      accountId,
      state: 'queued' as const,
      reason: 'seeded by the integration suite',
      // Distinct createdAt values: the claim orders by it, and rows sharing a
      // timestamp would make "the oldest N" ambiguous and the test flaky.
      createdAt: new Date(Date.now() - (count - order.get(p.handle)!) * 1000),
    })),
  });
  return handles;
}

/**
 * People who all share one createdAt.
 *
 * Not a shortcut -- it is the realistic case. `resolve` writes a whole sheet's
 * people in one createMany, so all 99 get the same DEFAULT now(), and the
 * ledger list orders by createdAt first. A cursor over a sort key that ties
 * across an entire page is precisely where a paginator repeats or skips rows,
 * and it is only the `id` tiebreak in that ORDER BY that stops it.
 */
export async function addPeopleAtOneInstant(
  personalityId: string,
  count: number,
  prefix = 'tied',
): Promise<string[]> {
  const handles = Array.from({ length: count }, (_, i) => `${prefix}_${i}`);
  const sameInstant = new Date();
  await prisma.person.createMany({
    data: handles.map((handle, i) => ({
      personalityId,
      handle,
      displayName: `Tied ${i}`,
      createdAt: sameInstant,
    })),
  });
  return handles;
}
