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
 * And to mint the secret an emulator types alongside the server address:
 *
 *   docker compose exec api node dist/cli/provision.js \
 *     --client "my agency" --enrol-token
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
import { EXTRACTION_MODELS } from '../extraction/models';

const prisma = new PrismaClient();

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

/** A bare `--flag`, with no value after it. */
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
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

  // A mode of its own, because minting a token for an existing client has
  // nothing to say about personalities or accounts and should not have to
  // invent them to get at the flag.
  if (flag('enrol-token')) {
    await mintEnrolToken(clientName);
    return;
  }

  const personalityName = arg('personality');
  const labels = list('accounts', '');
  const cap = Number(arg('cap', '240'));
  // English, and minConfidence low. Both measured, not guessed: three runs over
  // the golden sheet put 64-66 of 99 names in the English bucket, and 80 of 99
  // come back low confidence -- a medium bar passes 1 English-reading man in 65.
  //
  // Lowercase, like everything normCountry stores and like the options
  // /api/rules serves. The pipeline folds case so 'English' filtered correctly,
  // but the Targeting screen ticks its chips by exact string, so a provisioned
  // client opened its rules page to an unticked `english` chip on a rule that
  // was forwarding english.
  const countries = list('countries', 'english');
  // Empty rather than a hardcoded model name, so an unflagged run takes the
  // column default and there is one place that decides which model is default.
  // A literal here would have gone on provisioning 3.6-flash long after the
  // schema said otherwise, and nothing would have reported the disagreement.
  const model = arg('model', '');

  if (!labels.length) throw new Error('--accounts needs at least one label');
  if (!Number.isInteger(cap) || cap < 1) throw new Error('--cap must be a positive integer');
  // Checked here for the same reason the settings DTO checks it: an unrecognised
  // name is accepted by the column and then fails every extraction this client
  // ever uploads, one gateway error per sheet, with nothing pointing at the
  // typo.
  if (model && !(EXTRACTION_MODELS as readonly string[]).includes(model)) {
    throw new Error(`--model must be one of ${EXTRACTION_MODELS.join(', ')}`);
  }

  let client = await prisma.client.findFirst({ where: { name: clientName } });
  let apiKey: string | null = null;

  if (client) {
    // --cap deliberately does NOT apply here. It carries a default, so a re-run
    // that only meant to add an account would silently stamp 240 over whatever
    // the operator had set in the CRM. An existing client's cap is changed on
    // the Settings screen, which is the one place that owns it.
    console.log(
      `client "${clientName}" already exists; adding to it. Key and cap unchanged ` +
        `(cap ${client.dailyCapPerAccount}/day/account -- change it in the CRM).`,
    );
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
        ...(model ? { extractionModel: model } : {}),
        // One cap for every account this client will ever run. Per-account caps
        // are gone: what the cap protects against is Snapchat rate-limiting the
        // account doing the following, which is not a per-account property.
        dailyCapPerAccount: cap,
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
        update: {},
        // 'seeding', NOT the schema default. This command bootstraps a CRM
        // around accounts that already exist and are already running -- the
        // labels are typed in by an operator naming accounts they own -- and
        // the first rung of the ladder would tell the agent to delete their
        // friends, conversations and contacts. Same reasoning as the phase
        // migration's backfill: where nothing knows whether an account was
        // wiped, the destructive guess is the wrong one. onboardedCount is
        // still 0, so a genuinely new account here is search-seeded and
        // graduates to 'established' on its own.
        create: {
          personalityId: personality.id,
          label,
          enabled: true,
          phase: 'seeding',
        },
      }),
    );
  }

  const line = '='.repeat(72);
  console.log(`\n${line}\nprovisioned\n${line}`);
  console.log(`client       ${client.name}  (${client.id})`);
  console.log(`model        ${model}`);
  console.log(`personality  ${personality.name}  (${personality.id})`);
  for (const a of accounts) {
    console.log(`  account    ${a.label}  cap ${cap}/day  (${a.id})`);
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

/**
 * Mint (or rotate) the enrolment token and print it once.
 *
 * This is the secret an emulator types alongside the server address. It is not
 * a working credential: /v1/enrol trades it for a key belonging to that one
 * machine, so a box that is lost is revoked on its own. Rotating here does not
 * disturb machines that already enrolled -- they hold their own keys and never
 * present this again.
 */
async function mintEnrolToken(clientName: string): Promise<void> {
  const client = await prisma.client.findFirst({ where: { name: clientName } });
  if (!client) throw new Error(`no client named "${clientName}"`);

  const token = `et_${randomBytes(32).toString('base64url')}`;
  await prisma.client.update({
    where: { id: client.id },
    data: { enrolTokenHash: hashApiKey(token) },
  });

  const line = '='.repeat(72);
  const rotated = client.enrolTokenHash !== null;
  console.log(`\n${line}\nENROLMENT TOKEN -- SHOWN ONCE, ONLY THE HASH IS STORED\n${line}`);
  console.log(token);
  console.log(`\nclient  ${client.name}  (${client.id})`);
  if (rotated) {
    console.log(
      'This REPLACES the previous token. Machines that already enrolled are\n' +
        'unaffected -- they hold their own keys. Any machine still waiting to\n' +
        'enrol needs this new one.',
    );
  }
  console.log(
    '\nType it into the agent next to the server address. Once your machines\n' +
      'send it you can close the enrolment window for good:\n' +
      '  curl -XPOST http://<host>/api/enrolment/close -H "Authorization: Bearer <operator key>"',
  );
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
