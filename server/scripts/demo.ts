/**
 * End-to-end demo against a real database and the real gateway.
 *
 * Proves the claim the product is built on: the same person, seen by two of a
 * personality's accounts, is followed once. Account A uploads a sheet and gets
 * the targets; account B uploads the SAME sheet and gets none of them, because
 * the ledger already holds those people.
 *
 * Note that account B runs a genuinely independent extraction rather than
 * reusing A's result. That is the honest test: if the model reads a handle even
 * slightly differently on the second pass, dedupe fails and a duplicate follow
 * is created. Reusing the first reply would hide exactly the failure mode this
 * is meant to catch.
 *
 *   npx ts-node scripts/demo.ts
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { hashApiKey } from '../src/auth/api-key.guard';
import { GatewayClient } from '../src/extraction/gateway.client';
import { PipelineService } from '../src/pipeline/pipeline.service';
import { StorageService } from '../src/storage/storage.service';
import { TargetsService } from '../src/targets/targets.service';

const ROOT = join(__dirname, '..', '..');
const SHEET = join(ROOT, 'test', 'main', 'all99_3col.png');

process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = join(__dirname, '..', '.storage');
if (!process.env.APIMART_API_KEY) {
  process.env.APIMART_API_KEY = readFileSync(
    join(ROOT, 'vlm_eval', '.apimart_key'),
    'utf8',
  ).trim();
}

const prisma = new PrismaClient();
const storage = new StorageService();
const pipeline = new PipelineService(prisma as any, storage, new GatewayClient());
const targets = new TargetsService(prisma as any);

function rule(n: string) {
  return `\n${'='.repeat(72)}\n${n}\n${'='.repeat(72)}`;
}

async function seed() {
  await prisma.client.deleteMany({ where: { name: 'demo agency' } });
  const client = await prisma.client.create({
    data: {
      name: 'demo agency',
      apiKeyHash: hashApiKey('demo-key-001'),
      extractionModel: 'gemini-3.6-flash',
      personalities: {
        create: {
          name: 'kris',
          accounts: {
            create: [
              { label: 'kris_snap_01', dailyCap: 25 },
              { label: 'kris_snap_02', dailyCap: 25 },
              { label: 'kris_snap_03', dailyCap: 5 },
            ],
          },
        },
      },
      filterRules: {
        create: {
          position: 1,
          presentsAs: ['man'],
          countries: ['italian', 'french', 'spanish', 'turkish', 'indian', 'greek', 'danish'],
          minConfidence: 'medium',
          action: 'forward',
        },
      },
    },
    include: { personalities: { include: { accounts: true } } },
  });
  const personality = client.personalities[0];
  console.log(`client       ${client.name}`);
  console.log(`personality  ${personality.name}  (${personality.id})`);
  for (const a of personality.accounts) {
    console.log(`  account ${a.label}  cap ${a.dailyCap}/day`);
  }
  return { client, personality, accounts: personality.accounts };
}

async function upload(accountId: string, clientId: string) {
  const buf = readFileSync(SHEET);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const existing = await prisma.sheet.findUnique({
    where: { accountId_sha256: { accountId, sha256 } },
  });
  if (existing) return { sheetId: existing.id, duplicate: true };
  const key = storage.key(clientId, sha256);
  await storage.put(key, buf);
  const sheet = await prisma.sheet.create({
    data: { accountId, sha256, storageKey: key },
  });
  return { sheetId: sheet.id, duplicate: false };
}

async function main() {
  await storage.onModuleInit();

  console.log(rule('1. SEED'));
  const { client, personality, accounts } = await seed();
  const [a1, a2, a3] = accounts;

  console.log(rule('2. ACCOUNT 01 UPLOADS THE SHEET  (live extraction)'));
  const up1 = await upload(a1.id, client.id);
  const t0 = Date.now();
  await pipeline.run(up1.sheetId);
  const ex1 = await prisma.extraction.findUnique({ where: { sheetId: up1.sheetId } });
  console.log(
    `extracted in ${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
      `profiles=${ex1?.profilesFound}  cost $${Number(ex1?.usd).toFixed(4)}`,
  );
  console.log(`people in ledger        ${await prisma.person.count({ where: { personalityId: personality.id } })}`);
  console.log(`assigned to ${a1.label}  ${await prisma.assignment.count({ where: { accountId: a1.id } })}`);

  const byState = await prisma.assignment.groupBy({
    by: ['state'],
    where: { accountId: a1.id },
    _count: true,
  });
  for (const s of byState) console.log(`  ${s.state.padEnd(12)} ${s._count}`);

  console.log(rule('3. ACCOUNT 02 UPLOADS THE SAME SHEET  (independent extraction)'));
  console.log('this is the dedupe test: a second, separate model call over the');
  console.log('same image must produce ZERO new assignments.\n');
  const peopleBefore = await prisma.person.count({ where: { personalityId: personality.id } });
  const up2 = await upload(a2.id, client.id);
  const t1 = Date.now();
  await pipeline.run(up2.sheetId);
  const peopleAfter = await prisma.person.count({ where: { personalityId: personality.id } });
  const assigned2 = await prisma.assignment.count({ where: { accountId: a2.id } });
  console.log(`extracted in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`people before / after   ${peopleBefore} -> ${peopleAfter}   (new: ${peopleAfter - peopleBefore})`);
  console.log(`assigned to ${a2.label}  ${assigned2}`);
  console.log(
    assigned2 === 0 && peopleAfter === peopleBefore
      ? '\nDEDUPE HELD: account 02 received nothing that account 01 already has.'
      : `\nDEDUPE LEAK: ${peopleAfter - peopleBefore} new people, ${assigned2} new assignments.`,
  );

  console.log(rule('4. ACCOUNT 01 ASKS WHO TO FOLLOW  (daily cap 25)'));
  const first = await targets.claim(a1.id, 10);
  console.log(`claimed ${first.length}, remaining today ${await targets.remainingToday(a1.id)}`);
  for (const t of first.slice(0, 6)) {
    console.log(`  @${t.handle.padEnd(18)} ${(t.displayName || '').slice(0, 22).padEnd(24)} ${t.reason}`);
  }
  const second = await targets.claim(a1.id, 100);
  console.log(`asked for 100 more, got ${second.length} (cap ${a1.dailyCap} minus the 10 already taken)`);
  console.log(`remaining today ${await targets.remainingToday(a1.id)}`);

  console.log(rule('5. ACCOUNT 01 REPORTS RESULTS'));
  if (first.length >= 2) {
    await targets.report(a1.id, first[0].handle, 'followed');
    await targets.report(a1.id, first[1].handle, 'failed', 'rate limited by the app');
    console.log(`@${first[0].handle} -> followed`);
    console.log(`@${first[1].handle} -> failed, requeued for another attempt`);
    const back = await prisma.assignment.findFirst({
      where: { person: { handle: first[1].handle, personalityId: personality.id } },
    });
    console.log(`  state is now '${back?.state}' (a failure returns to the queue, a skip does not)`);
  }

  console.log(rule('6. LEDGER'));
  const ledger = await targets.ledger(personality.id, 8);
  for (const p of ledger) {
    const asn = p.assignment;
    console.log(
      `  @${p.handle.padEnd(18)} ${(p.displayName || '').slice(0, 18).padEnd(20)}` +
        `${p.presentsAs.padEnd(13)}${(p.nationality ?? '-').padEnd(12)}` +
        `seen×${String(p.timesSeen).padEnd(3)}${asn ? `${asn.account.label}/${asn.state}` : 'unassigned'}`,
    );
  }

  const totals = await prisma.assignment.groupBy({ by: ['state'], _count: true });
  console.log('\nassignments across the whole personality:');
  for (const t of totals) console.log(`  ${t.state.padEnd(12)} ${t._count}`);
  const spend = await prisma.extraction.aggregate({ _sum: { usd: true } });
  console.log(`\ntotal model spend this demo  $${Number(spend._sum.usd).toFixed(4)}`);
}

void main()
  .catch((e) => {
    console.error('FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
