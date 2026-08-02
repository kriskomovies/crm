/**
 * Create a real client, personality and accounts on a fresh deployment.
 *
 * There is no HTTP route that onboards a client -- the API key is hashed on the
 * way in and never stored in the clear, so there is nothing for an endpoint to
 * hand back and no operator UI to hand it to. Until this script existed the
 * only ways to get a usable key were demo.ts (hardcoded `demo-key-001` plus a
 * fake personality) and seed.ts (twenty thousand fabricated people). Neither
 * belongs on a machine that is about to follow real accounts.
 *
 *   npx ts-node scripts/provision.ts \
 *     --client "my agency" --personality kris \
 *     --accounts kris_snap_01,kris_snap_02 --cap 240 \
 *     --countries italian,french,spanish
 *
 * The key is GENERATED here and printed ONCE. It cannot be recovered
 * afterwards: only its hash is stored, which is the point. Re-running with the
 * same --client name adds personalities and accounts to the existing client
 * rather than duplicating it, and issues no new key.
 *
 * Prints the client machine's config.toml at the end, so the next step is a
 * copy-paste rather than a schema-reading exercise.
 */
import { randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { hashApiKey } from '../src/auth/api-key.guard';

const prisma = new PrismaClient();

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

function list(name: string, fallback: string): string[] {
  // Split on whitespace as well as commas. PowerShell turns `a,b` into an array
  // and hands the native command "a b", so a comma-separated list arrives
  // space-separated and silently became ONE account named "a b" -- a label that
  // then has to be un-picked out of the database by hand.
  return arg(name, fallback)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const clientName = arg('client');
  const personalityName = arg('personality');
  const labels = list('accounts', '');
  const cap = Number(arg('cap', '240'));
  const countries = list('countries', 'italian,french,spanish,turkish,indian,greek,danish');
  const model = arg('model', 'gemini-3.6-flash');

  if (!labels.length) throw new Error('--accounts needs at least one label');
  if (!Number.isInteger(cap) || cap < 1) throw new Error('--cap must be a positive integer');

  let client = await prisma.client.findFirst({ where: { name: clientName } });
  let apiKey: string | null = null;

  if (client) {
    console.log(`client "${clientName}" already exists; adding to it. Key unchanged.`);
  } else {
    // 32 bytes of urandom. Long enough that the hash is the only thing worth
    // attacking, and url-safe so it survives being pasted into a TOML file.
    apiKey = `sk_${randomBytes(32).toString('base64url')}`;
    client = await prisma.client.create({
      data: {
        name: clientName,
        apiKeyHash: hashApiKey(apiKey),
        extractionModel: model,
        // Without a rule NOTHING is ever forwarded: filter falls through and
        // every extracted person sits in the ledger unassigned, which looks
        // exactly like a broken pipeline. One rule at position 1 is the
        // smallest thing that makes a first end-to-end test meaningful.
        filterRules: {
          create: {
            position: 1,
            presentsAs: ['man'],
            countries,
            minConfidence: 'medium',
            action: 'forward',
          },
        },
      },
    });
  }

  const personality = await prisma.personality.upsert({
    where: { clientId_name: { clientId: client.id, name: personalityName } },
    update: {},
    create: { clientId: client.id, name: personalityName },
  });

  // Typed explicitly: an empty literal infers never[], which tsconfig.json does
  // not cover because scripts/ is outside that project -- ts-node is what
  // compiles this file, and it is stricter.
  type Provisioned = Awaited<ReturnType<typeof prisma.account.upsert>>;
  const accounts: Provisioned[] = [];
  for (const label of labels) {
    accounts.push(
      await prisma.account.upsert({
        where: { personalityId_label: { personalityId: personality.id, label } },
        update: { dailyCap: cap },
        create: { personalityId: personality.id, label, dailyCap: cap, enabled: true },
      }),
    );
  }

  const line = '='.repeat(72);
  console.log(`\n${line}\nprovisioned\n${line}`);
  console.log(`client       ${client.name}  (${client.id})`);
  console.log(`model        ${model}`);
  console.log(`personality  ${personality.name}  (${personality.id})`);
  for (const a of accounts) console.log(`  account    ${a.label}  cap ${a.dailyCap}/day  (${a.id})`);

  if (apiKey) {
    console.log(`\n${line}\nAPI KEY -- SHOWN ONCE, ONLY THE HASH IS STORED\n${line}`);
    console.log(apiKey);
  }

  console.log(`\n${line}\nconfig.toml for the emulator machine\n${line}`);
  console.log(`server_url = "https://YOUR-CRM-HOSTNAME"`);
  console.log(`api_key = "${apiKey ?? '<the key you saved when this client was created>'}"`);
  for (const [i, a] of accounts.entries()) {
    console.log(`\n[[accounts]]`);
    console.log(`account_id = "${a.id}"`);
    console.log(`label = "${a.label}"`);
    console.log(`emulator_index = ${i}`);
  }
  console.log();
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
