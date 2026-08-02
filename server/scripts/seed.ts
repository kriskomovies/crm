/**
 * Bulk seed: enough volume that pagination, indexes and the stats rollups are
 * exercised by something other than a dozen hand-typed rows.
 *
 *   npx ts-node scripts/seed.ts [--reset]
 *
 * Deterministic. Every value comes from one seeded PRNG, so two runs produce
 * byte-identical data and a timing measured today is comparable with one
 * measured next week. Nothing here calls Math.random.
 *
 * The seeded clients are namespaced by SEED_PREFIX and --reset deletes only
 * those. "demo agency" is left alone deliberately: it holds the extraction from
 * a live Gemini run and re-creating it costs real money.
 *
 * Volume is written with createMany in batches. The row-at-a-time version of
 * this script took minutes for the 20,000 people; batched it is seconds.
 */
import {
  $Enums,
  AssignmentState,
  PersonSource,
  Presents,
  Prisma,
  PrismaClient,
  SheetStatus,
} from '@prisma/client';

import { hashApiKey } from '../src/auth/api-key.guard';
import { priceUsd } from '../src/extraction/pricing';
import { combinePresents, presentsToDb, signalsDisagree, PresentsValue } from '../src/extraction/normalize';

const SEED = 0x5eed1234;
const SEED_PREFIX = 'seed ';

/** People to create in total, spread unevenly across the personalities. */
const PEOPLE_TOTAL = 20_000;
const SHEETS_TOTAL = 320;
/**
 * How far back the timeline runs. Longer than the stats endpoint's default
 * 30-day window on purpose, so a default load has data on every day of it and
 * a widened range still shows the edge.
 */
const WINDOW_DAYS = 45;
const BATCH = 2_000;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Deterministic primitives
// ---------------------------------------------------------------------------

/** mulberry32. Small, fast, and identical across Node versions. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(SEED);

/**
 * A v4-shaped id drawn from the seeded PRNG rather than crypto.randomUUID, so
 * ids are stable between runs. Prisma's uuid() default is a plain String column
 * here, so nothing validates the version nibble -- it is set only so the values
 * look like what the application writes.
 */
function uuid(): string {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) bytes.push(Math.floor(rng() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function int(minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** Weighted choice over [value, weight] pairs. Weights need not sum to 1. */
function weighted<T>(table: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, w] of table) total += w;
  let roll = rng() * total;
  for (const [value, w] of table) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return table[table.length - 1][0];
}

/** A timestamp `days` back from now, biased so recent days are busier. */
function backdate(maxDaysAgo: number): Date {
  // Squaring the uniform draw puts roughly half the rows in the most recent
  // quarter of the window, which is what a growing account actually looks like
  // and keeps the byDay series from being a flat line.
  const daysAgo = maxDaysAgo * rng() * rng();
  return new Date(Date.now() - daysAgo * DAY_MS);
}

function sha256ish(): string {
  let out = '';
  for (let i = 0; i < 64; i++) out += '0123456789abcdef'[int(0, 15)];
  return out;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'liam', 'noah', 'oliver', 'james', 'elijah', 'mateo', 'theodore', 'henry',
  'lucas', 'william', 'benjamin', 'levi', 'sebastian', 'jack', 'ezra', 'michael',
  'daniel', 'leo', 'owen', 'samuel', 'hudson', 'asher', 'luca', 'jackson',
  'gabriel', 'wyatt', 'julian', 'carter', 'jayden', 'ethan', 'caleb', 'grayson',
  'dylan', 'isaac', 'ryan', 'nathan', 'adrian', 'miles', 'eli', 'aaron',
  'charlie', 'jordan', 'riley', 'avery', 'quinn', 'rowan', 'sage', 'emerson',
  'olivia', 'emma', 'amelia', 'sophia', 'isabella', 'mia', 'luna', 'harper',
  'nora', 'chloe', 'aria', 'ella', 'maya', 'zoe', 'ivy', 'hazel',
  'omar', 'yusuf', 'kaan', 'emre', 'mehmet', 'luca', 'matteo', 'giovanni',
  'santiago', 'diego', 'rafael', 'joao', 'pedro', 'andres', 'nikos', 'dimitri',
  'lars', 'sven', 'jonas', 'kasper', 'mikkel', 'piotr', 'tomasz', 'ivan',
  'arjun', 'rohan', 'vikram', 'aditya', 'kenji', 'haruto', 'minjun', 'jihoon',
];

const SURNAMES = [
  'brooks', 'reed', 'walsh', 'hayes', 'ellis', 'foster', 'grant', 'shaw',
  'baker', 'cole', 'doyle', 'flynn', 'gibson', 'hart', 'keane', 'lowe',
  'marsh', 'nolan', 'pike', 'quinn', 'rhodes', 'stone', 'todd', 'vance',
  'ward', 'york', 'blake', 'chase', 'drake', 'east', 'frost', 'gray',
];

const HANDLE_WORDS = [
  'official', 'real', 'the', 'its', 'iam', 'mr', 'young', 'big',
  'lil', 'king', 'gains', 'fit', 'travels', 'photo', 'music', 'skates',
  'hoops', 'surf', 'moto', 'drift', 'chef', 'brew', 'lifts', 'runs',
];

/**
 * Long tail with a heavy head. Mirrors what the live extraction produced: a
 * client's country filter is only interesting because "american" swamps
 * everything else, and byCountry is a flat useless list without the tail.
 */
const NATIONALITIES: readonly (readonly [string | null, number])[] = [
  ['american', 460],
  ['british', 70],
  ['canadian', 50],
  ['australian', 40],
  ['mexican', 35],
  ['indian', 30],
  ['german', 26],
  ['french', 24],
  ['italian', 22],
  ['spanish', 20],
  ['brazilian', 20],
  ['turkish', 18],
  ['dutch', 15],
  ['polish', 14],
  ['swedish', 12],
  ['danish', 10],
  ['greek', 10],
  ['norwegian', 9],
  ['irish', 9],
  ['filipino', 9],
  ['nigerian', 8],
  ['japanese', 7],
  ['korean', 7],
  ['colombian', 6],
  ['argentinian', 6],
  ['egyptian', 5],
  ['portuguese', 5],
  ['vietnamese', 4],
  ['moroccan', 4],
  ['romanian', 4],
  ['ukrainian', 3],
  ['finnish', 3],
  ['czech', 3],
  ['israeli', 2],
  ['thai', 2],
  ['peruvian', 2],
  ['kenyan', 1],
  ['icelandic', 1],
  // No country read at all. Common enough that the filter has to cope with it.
  [null, 40],
];

const PRESENTS_TABLE: readonly (readonly [PresentsValue, number])[] = [
  ['man', 620],
  ['woman', 180],
  ['ambiguous', 90],
  ['unknown', 80],
  ['not-a-person', 30],
];

const CLIENTS = [
  { name: `${SEED_PREFIX}northwind`, model: 'gemini-3.6-flash', avatarPass: true, budget: 400 },
  { name: `${SEED_PREFIX}harbor`, model: 'gemini-2.5-flash', avatarPass: false, budget: 150 },
  { name: `${SEED_PREFIX}lantern`, model: 'gpt-5.4-mini', avatarPass: false, budget: 250 },
];

const PERSONALITY_NAMES = [
  ['kris', 'mia', 'devon', 'sasha'],
  ['jules', 'robin', 'noa', 'tam'],
  ['alex', 'kai', 'remy', 'wren'],
];

/**
 * How the 20,000 people divide. Deliberately lopsided: one personality holds a
 * quarter of the estate so a cursor walk over it is genuinely many pages, and
 * the smallest holds a couple of hundred so the "new personality" case is
 * represented too.
 */
const PERSONALITY_WEIGHTS = [4600, 2800, 1600, 1000, 2400, 1600, 1200, 800, 2000, 1200, 600, 200];

/**
 * Handles planted in several personalities at once.
 *
 * This is the product's central invariant expressed as data: `UNIQUE
 * (personalityId, handle)` is scoped, so kris and mia may both hold @brooks_fit
 * and each gets their own Assignment. A global unique on handle would make this
 * seed fail outright -- which is the point of putting it in the fixture rather
 * than only in a test.
 */
const SHARED_HANDLES = [
  'brooks_fit', 'realhayes', 'mattlifts', 'dgrayson.07', 'kaan_drift',
  'nolanbrew', 'iamyorkie', 'sven_runs', 'chefpike', 'luca.marsh',
  'quinnhoops', 'frost_moto', 'bigreed', 'travelsblake', 'omar_photo',
  'kenji.surf', 'tomaszgains', 'ellis_king', 'young_vance', 'rhodesmusic',
  'mrkeane', 'itsdoyle', 'lilchase', 'east_skates', 'gibsonjr',
  'hartland', 'lowe_official', 'pedro_gym', 'stone.cold9', 'wardy_b',
];

// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

interface SeedAccount {
  id: string;
  label: string;
  dailyCap: number;
  enabled: boolean;
}

interface SeedPersonality {
  id: string;
  name: string;
  clientId: string;
  model: string;
  accounts: SeedAccount[];
  /** Sheet ids belonging to this personality's accounts, for firstSeenSheetId. */
  sheets: { id: string; accountId: string; receivedAt: Date }[];
}

async function reset(): Promise<void> {
  const names = CLIENTS.map((c) => c.name);
  // Belt and braces. The seeded names are all prefixed, but a typo above must
  // not be able to reach the live-extraction client.
  if (names.some((n) => !n.startsWith(SEED_PREFIX))) {
    throw new Error('refusing to reset: a client name is missing the seed prefix');
  }
  const { count } = await prisma.client.deleteMany({ where: { name: { in: names } } });
  console.log(`reset: removed ${count} seeded client(s)`);
}

/** Insert in chunks; one 20,000-row INSERT is slower than ten 2,000-row ones. */
async function insertBatched<T>(
  label: string,
  rows: T[],
  write: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  const started = Date.now();
  for (let i = 0; i < rows.length; i += BATCH) {
    await write(rows.slice(i, i + BATCH));
  }
  console.log(`  ${label.padEnd(12)} ${String(rows.length).padStart(6)}  ${Date.now() - started}ms`);
}

function makeHandle(taken: Set<string>): string {
  for (let attempt = 0; attempt < 40; attempt++) {
    const first = pick(FIRST_NAMES);
    let handle: string;
    switch (int(0, 5)) {
      case 0:
        handle = `${first}${int(1, 99)}`;
        break;
      case 1:
        handle = `${first}_${pick(SURNAMES)}`;
        break;
      case 2:
        handle = `${first}.${pick(SURNAMES).slice(0, 4)}`;
        break;
      case 3:
        handle = `${pick(HANDLE_WORDS)}${first}`;
        break;
      case 4:
        handle = `${first}${pick(SURNAMES).slice(0, 3)}${int(0, 9)}`;
        break;
      default:
        handle = `${first}_${pick(HANDLE_WORDS)}`;
    }
    handle = handle.slice(0, 15);
    if (handle.length >= 3 && !taken.has(handle)) {
      taken.add(handle);
      return handle;
    }
  }
  // Exhausted the vocabulary for this personality; fall back to a counter.
  let n = taken.size;
  let handle = `u${n}x${int(100, 999)}`;
  while (taken.has(handle)) handle = `u${++n}x${int(100, 999)}`;
  taken.add(handle);
  return handle;
}

function displayNameFor(handle: string): string {
  const base = handle.replace(/[._-]/g, ' ').replace(/\d+/g, '').trim();
  const words = base.split(/\s+/).filter(Boolean).slice(0, 2);
  const proper = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  if (!proper) return handle;
  // A minority carry emoji, as real Snapchat display names do -- the store path
  // keeps them and the normaliser has to survive them.
  return rng() < 0.12 ? `${proper} ${pick(['🔥', '💯', '🏀', '⚡', '🇮🇹', '🇹🇷'])}` : proper;
}

async function main(): Promise<void> {
  const doReset = process.argv.includes('--reset');
  const existing = await prisma.client.count({
    where: { name: { in: CLIENTS.map((c) => c.name) } },
  });
  if (existing > 0 && !doReset) {
    throw new Error(
      `${existing} seeded client(s) already present; re-run with --reset to replace them`,
    );
  }
  if (doReset) await reset();

  const t0 = Date.now();

  // --- clients, personalities, accounts ------------------------------------
  const personalities: SeedPersonality[] = [];
  for (let ci = 0; ci < CLIENTS.length; ci++) {
    const spec = CLIENTS[ci];
    const clientId = uuid();
    await prisma.client.create({
      data: {
        id: clientId,
        name: spec.name,
        apiKeyHash: hashApiKey(`seed-key-${ci + 1}`),
        extractionModel: spec.model,
        avatarPassEnabled: spec.avatarPass,
        monthlyBudgetUsd: new Prisma.Decimal(spec.budget),
        filterRules: {
          create: {
            position: 1,
            presentsAs: ['man'],
            countries: ci === 0 ? [] : ['italian', 'turkish', 'greek', 'spanish', 'french'],
            minConfidence: 'medium',
            action: 'forward',
          },
        },
      },
    });

    for (const name of PERSONALITY_NAMES[ci]) {
      const personalityId = uuid();
      await prisma.personality.create({ data: { id: personalityId, clientId, name } });
      const accounts: SeedAccount[] = [];
      for (let ai = 1; ai <= 5; ai++) {
        const account = {
          id: uuid(),
          label: `${name}_snap_${String(ai).padStart(2, '0')}`,
          dailyCap: pick([25, 40, 50, 50, 75]),
          // One account per personality is paused, because the handout and the
          // spread-by-queue-depth paths both have to skip disabled accounts.
          enabled: ai !== 5,
        };
        accounts.push(account);
        await prisma.account.create({ data: { personalityId, ...account } });
      }
      personalities.push({ id: personalityId, name, clientId, model: spec.model, accounts, sheets: [] });
    }
  }
  console.log(
    `clients ${CLIENTS.length}  personalities ${personalities.length}  accounts ${personalities.length * 5}`,
  );

  // --- sheets and extractions ----------------------------------------------
  const sheetRows: Prisma.SheetCreateManyInput[] = [];
  const extractionRows: Prisma.ExtractionCreateManyInput[] = [];
  for (let i = 0; i < SHEETS_TOTAL; i++) {
    const personality = personalities[int(0, personalities.length - 1)];
    const account = pick(personality.accounts);
    const receivedAt = backdate(WINDOW_DAYS);
    const status = weighted<SheetStatus>([
      [$Enums.SheetStatus.extracted, 74],
      [$Enums.SheetStatus.partial, 16],
      [$Enums.SheetStatus.failed, 5],
      [$Enums.SheetStatus.rejected, 3],
      [$Enums.SheetStatus.received, 2],
    ]);
    const id = uuid();
    const sha256 = sha256ish();
    sheetRows.push({
      id,
      accountId: account.id,
      sha256,
      storageKey: `${personality.clientId}/${sha256.slice(0, 2)}/${sha256}.png`,
      width: 1170,
      height: pick([2532, 2778, 2340]),
      status,
      error:
        status === $Enums.SheetStatus.failed
          ? 'gateway timed out after 120s'
          : status === $Enums.SheetStatus.rejected
            ? 'templated avatar descriptions (0.04 distinct) — model not reading the image'
            : null,
      receivedAt,
    });

    // 'received' never reached the model, so it has no extraction to bill.
    if (status === $Enums.SheetStatus.received) continue;
    const promptTokens = int(1_400, 2_800);
    const completionTokens = int(2_800, 6_200);
    const profilesFound =
      status === $Enums.SheetStatus.extracted
        ? 99
        : status === $Enums.SheetStatus.partial
          ? int(61, 97)
          : status === $Enums.SheetStatus.failed
            ? 0
            : int(80, 99);
    extractionRows.push({
      id: uuid(),
      sheetId: id,
      model: personality.model,
      promptTokens,
      completionTokens,
      usd: new Prisma.Decimal(
        priceUsd(personality.model, promptTokens, completionTokens).toFixed(6),
      ),
      seconds: Number((30 + rng() * 65).toFixed(1)),
      // The real column holds the model's reply verbatim, ~40KB a row. The seed
      // exists to exercise counts and joins, not to store 12MB of fake JSON.
      rawReply: '[seeded: raw reply not retained]' as unknown as Prisma.InputJsonValue,
      profilesFound,
      distinctCuesRatio:
        status === $Enums.SheetStatus.rejected
          ? Number((rng() * 0.2).toFixed(3))
          : Number((0.7 + rng() * 0.3).toFixed(3)),
      createdAt: new Date(receivedAt.getTime() + int(20_000, 90_000)),
    });
    personality.sheets.push({ id, accountId: account.id, receivedAt });
  }

  console.log('writing:');
  await insertBatched('sheets', sheetRows, (chunk) =>
    prisma.sheet.createMany({ data: chunk }),
  );
  await insertBatched('extractions', extractionRows, (chunk) =>
    prisma.extraction.createMany({ data: chunk }),
  );

  // --- people ---------------------------------------------------------------
  const totalWeight = PERSONALITY_WEIGHTS.reduce((a, b) => a + b, 0);
  const peopleRows: Prisma.PersonCreateManyInput[] = [];
  const assignmentRows: Prisma.AssignmentCreateManyInput[] = [];

  // Which personalities each shared handle is planted in. Decided up front so
  // the report at the end can state the overlap without re-querying for it.
  const sharedPlan = new Map<number, string[]>();
  for (const handle of SHARED_HANDLES) {
    const count = int(3, 6);
    const chosen = new Set<number>();
    while (chosen.size < count) chosen.add(int(0, personalities.length - 1));
    for (const idx of chosen) {
      const list = sharedPlan.get(idx) ?? [];
      list.push(handle);
      sharedPlan.set(idx, list);
    }
  }

  for (let pi = 0; pi < personalities.length; pi++) {
    const personality = personalities[pi];
    const target = Math.round((PERSONALITY_WEIGHTS[pi] / totalWeight) * PEOPLE_TOTAL);
    const taken = new Set<string>();
    const planted = sharedPlan.get(pi) ?? [];
    for (const h of planted) taken.add(h);

    const enabled = personality.accounts.filter((a) => a.enabled);
    let roundRobin = 0;

    for (let n = 0; n < target; n++) {
      const handle = n < planted.length ? planted[n] : makeHandle(taken);
      const source = weighted<PersonSource>([
        [$Enums.PersonSource.extraction, 78],
        [$Enums.PersonSource.manual, 22],
      ]);

      const avatar = weighted(PRESENTS_TABLE);
      // The name usually agrees with the avatar. The minority that does not is
      // the whole reason namePresentsAs is stored separately, so it is seeded
      // at a rate that visibly moves the gap between people and assignments.
      const name: PresentsValue = rng() < 0.09 ? weighted(PRESENTS_TABLE) : avatar;
      const combined = combinePresents(avatar, name);

      const nationality = weighted(NATIONALITIES);
      const createdAt = backdate(WINDOW_DAYS);

      // An extracted person came off a sheet; a manual one was typed and has no
      // sheet behind it. Only sheets from this personality are eligible -- a
      // firstSeenSheetId pointing at another personality's upload would be a
      // lie the schema happily stores.
      const sheet =
        source === $Enums.PersonSource.extraction && personality.sheets.length > 0
          ? personality.sheets[int(0, personality.sheets.length - 1)]
          : null;

      const personId = uuid();
      peopleRows.push({
        id: personId,
        personalityId: personality.id,
        handle,
        displayName: displayNameFor(handle),
        source,
        presentsAs: presentsToDb(combined) as Presents,
        avatarPresentsAs: presentsToDb(avatar) as Presents,
        namePresentsAs: presentsToDb(name) as Presents,
        nationality,
        nationalityConf: nationality
          ? weighted([
              ['high', 55],
              ['medium', 30],
              ['low', 15],
            ])
          : null,
        avatarCues: sheet ? `${pick(['short dark hair', 'beard', 'sunglasses', 'cap', 'group photo', 'car interior'])}, ${pick(['outdoors', 'indoors', 'gym', 'beach'])}` : null,
        firstSeenSheetId: sheet?.id ?? null,
        timesSeen: weighted([
          [1, 80],
          [2, 13],
          [3, 5],
          [4, 2],
        ]),
        createdAt,
        updatedAt: createdAt,
      });

      // Roughly one in seven is filtered out entirely and never reaches an
      // account, so `people` and `assignments` do not sit at exactly 1:1 --
      // several stats numbers would agree by accident if they did.
      if (rng() < 0.14 || enabled.length === 0) continue;

      // Extraction people belong to the account whose sheet found them, because
      // Quick Add is per-account. Manual adds have no such account and are
      // spread round robin, matching PersonalitiesService.queueAll.
      const accountId = sheet
        ? sheet.accountId
        : enabled[roundRobin++ % enabled.length].id;

      // A disagreement between avatar and name is never forwarded, and the
      // pipeline drops it rather than recording the decision anywhere -- so the
      // seed leaves the person in the ledger with no assignment at all, which
      // is exactly what `filter` does. Seeding a state here would invent a row
      // the real pipeline cannot produce.
      if (signalsDisagree(avatar, name)) continue;

      const state: AssignmentState = weighted<AssignmentState>([
        [$Enums.AssignmentState.followed, 380],
        [$Enums.AssignmentState.queued, 300],
        [$Enums.AssignmentState.handed_out, 80],
        [$Enums.AssignmentState.skipped, 70],
        [$Enums.AssignmentState.failed, 60],
      ]);

      const assignedAt = new Date(createdAt.getTime() + int(1_000, 600_000));
      // handedOutAt is what the daily cap is metered on, so it is set for every
      // state that has actually been given to an account. A failed follow keeps
      // it -- the attempt was really made -- and so do the few requeued rows.
      const wasHandedOut = state !== $Enums.AssignmentState.queued || rng() < 0.03;
      const handedOutAt = wasHandedOut
        ? new Date(Math.min(Date.now(), assignedAt.getTime() + int(60_000, 4 * DAY_MS)))
        : null;

      assignmentRows.push({
        id: uuid(),
        personId,
        accountId,
        state,
        reason:
          source === $Enums.PersonSource.manual
            ? 'added manually'
            : `${presentsToDb(combined)}, ${nationality ?? 'unknown'}`,
        handedOutAt,
        resultAt:
          handedOutAt &&
          state !== $Enums.AssignmentState.handed_out &&
          state !== $Enums.AssignmentState.queued
            ? new Date(Math.min(Date.now(), handedOutAt.getTime() + int(30_000, DAY_MS)))
            : null,
        note: state === $Enums.AssignmentState.failed ? 'rate limited by the app' : null,
        createdAt: assignedAt,
      });
    }
  }

  await insertBatched('people', peopleRows, (chunk) =>
    prisma.person.createMany({ data: chunk }),
  );
  await insertBatched('assignments', assignmentRows, (chunk) =>
    prisma.assignment.createMany({ data: chunk }),
  );

  // --- report ---------------------------------------------------------------
  const crossPersonality = await prisma.$queryRaw<{ handles: number; rows: number }[]>`
    SELECT COUNT(*)::int AS handles, COALESCE(SUM(n), 0)::int AS rows
    FROM (
      SELECT handle, COUNT(DISTINCT "personalityId")::int AS n
      FROM people
      GROUP BY handle
      HAVING COUNT(DISTINCT "personalityId") > 1
    ) shared
  `;
  const states = await prisma.assignment.groupBy({ by: ['state'], _count: true });
  const biggest = personalities[0];

  console.log(`\nseeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`largest personality  ${biggest.name} (${biggest.id})`);
  console.log(
    `handles held by more than one personality: ${crossPersonality[0].handles} ` +
      `across ${crossPersonality[0].rows} ledger rows`,
  );
  for (const s of states) console.log(`  ${s.state.padEnd(12)} ${s._count}`);
}

void main()
  .catch((e) => {
    console.error('FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
