/**
 * Create a real client, personality and accounts on a fresh deployment.
 *
 * Lives under src/ rather than scripts/ so that `nest build` compiles it and it
 * reaches the runtime image. scripts/ is excluded from tsconfig, and the image
 * installs with --omit=dev, so a scripts/*.ts entry point has neither its source
 * nor ts-node in the container -- which made onboarding impossible on exactly
 * the machine where onboarding happens.
 *
 *   docker compose exec api node dist/cli/provision.js \
 *     --client "my agency" --personality kris \
 *     --accounts kris_snap_01,kris_snap_02 --cap 240
 *
 * There is no HTTP route that does this. The API key is hashed on the way in and
 * never stored in the clear, so there is nothing for an endpoint to hand back.
 *
 * The key is GENERATED here and printed ONCE; only its hash is kept. Re-running
 * with the same --client name adds to the existing client and issues no new key.
 */
import { randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { hashApiKey } from '../auth/api-key.guard';

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
  // Whitespace as well as commas: PowerShell turns `a,b` into an array and
  // passes "a b", which silently became ONE account named "a b".
  return arg(name, fallback)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function main(): Promise<void> {
  const clientName = arg('client');
  const personalityName = arg('personality');
  const labels = list('accounts', '');
  const cap = Number(arg('cap', '240'));
  // English, and minConfidence low. Both measured, not guessed: three runs over
  // the golden sheet put 64-66 of 99 names in the English bucket, and 80 of 99
  // come back low confidence -- a medium bar passes 1 English-reading man in 65.
  const countries = list('countries', 'English');
  const model = arg('model', 'gemini-3.6-flash');

  if (!labels.length) throw new Error('--accounts needs at least one label');
  if (!Number.isInteger(cap) || cap < 1) throw new Error('--cap must be a positive integer');

  let client = await prisma.client.findFirst({ where: { name: clientName } });
  let apiKey: string | null = null;

  if (client) {
    console.log(`client "${clientName}" already exists; adding to it. Key unchanged.`);
  } else {
    // --key registers a key you already have rather than inventing one. The
    // deploy needs this: bootstrap writes a random OPERATOR_API_KEY into .env
    // and Caddy injects it into /api/*, but nothing had ever registered it as a
    // client -- so the operator UI authenticated at Caddy and then got 401 from
    // the API, with both halves behaving exactly as designed.
    apiKey = arg('key', '') || `sk_${randomBytes(32).toString('base64url')}`;
    client = await prisma.client.create({
      data: {
        name: clientName,
        apiKeyHash: hashApiKey(apiKey),
        extractionModel: model,
        // Without a rule NOTHING is forwarded: filter falls through, every
        // extracted person sits unassigned, and a first end-to-end test looks
        // exactly like a broken pipeline.
        filterRules: {
          create: {
            position: 1,
            presentsAs: ['man'],
            countries,
            minConfidence: 'low',
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
  for (const a of accounts) {
    console.log(`  account    ${a.label}  cap ${a.dailyCap}/day  (${a.id})`);
  }

  if (apiKey) {
    console.log(`\n${line}\nAPI KEY -- SHOWN ONCE, ONLY THE HASH IS STORED\n${line}`);
    console.log(apiKey);
    console.log(
      '\nYou do not need to copy this onto a machine: agents enrol for their own\n' +
        'key. Keep it for the operator UI and for curl.',
    );
  }
  console.log();
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
