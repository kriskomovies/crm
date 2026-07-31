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

import { hashApiKey } from '../src/auth/api-key.guard';
import { GatewayClient } from '../src/extraction/gateway.client';
import { PersonalitiesService } from '../src/personalities/personalities.service';
import { PipelineService } from '../src/pipeline/pipeline.service';
import { StorageService } from '../src/storage/storage.service';
import { TargetsService } from '../src/targets/targets.service';

export const prisma = new PrismaClient();

// `as any` for the client, as scripts/demo.ts does: PrismaService adds only
// Nest lifecycle hooks to PrismaClient, and there is no Nest lifecycle here.
const pipeline = new PipelineService(prisma as any, new StorageService(), new GatewayClient());
export const personalities = new PersonalitiesService(prisma as any, pipeline);
export const targets = new TargetsService(prisma as any);

export interface TestAccount {
  id: string;
  label: string;
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
}

/** Clients this run created, so afterEach can drop exactly those and no others. */
const created: string[] = [];

function accountData(name: string, opts: FixtureOptions) {
  const count = opts.accounts ?? 1;
  return Array.from({ length: count }, (_, i) => ({
    label: `${name}_snap_${String(i + 1).padStart(2, '0')}`,
    dailyCap: opts.dailyCap ?? 50,
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
      accounts: p.accounts.map((a) => ({ id: a.id, label: a.label, dailyCap: a.dailyCap })),
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
    include: { accounts: { orderBy: { label: 'asc' } } },
  });
  return {
    id: p.id,
    name: p.name,
    accounts: p.accounts.map((a) => ({ id: a.id, label: a.label, dailyCap: a.dailyCap })),
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
 * Review-state assignments that all share one createdAt.
 *
 * Not a shortcut -- it is the realistic case. `allocate` writes a whole sheet's
 * decisions in one batch, so every row in it gets the same DEFAULT now(), and
 * the review list orders by createdAt first. A cursor over a sort key that ties
 * across an entire page is precisely where a paginator repeats or skips rows.
 */
export async function queueReview(
  personalityId: string,
  accountId: string,
  count: number,
  prefix = 'held',
): Promise<string[]> {
  const handles = await addPeople(personalityId, count, prefix);
  const people = await prisma.person.findMany({
    where: { personalityId, handle: { in: handles } },
    select: { id: true },
  });
  const sameInstant = new Date();
  await prisma.assignment.createMany({
    data: people.map((p) => ({
      personId: p.id,
      accountId,
      state: 'review' as const,
      reason: 'avatar reads woman, name reads man',
      createdAt: sameInstant,
    })),
  });
  return handles;
}
