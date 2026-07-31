// Row counts + queue state, for verifying the DB is intact after a test run.
// Account labels repeat across clients (several seeded clients each have a
// "kris" with a "kris_snap_01"), so per-account output is keyed by id and
// scoped to one client rather than grouped by label.
//
//   node scripts/db-counts.js [clientName]
const { PrismaClient } = require('@prisma/client');

const p = new PrismaClient();
const CLIENT = process.argv[2] || 'demo agency';

(async () => {
  const [clients, personalities, people, assignments, sheets] = await Promise.all([
    p.client.count(),
    p.personality.count(),
    p.person.count(),
    p.assignment.count(),
    p.sheet.count(),
  ]);
  console.log('== global row counts ==');
  console.log(JSON.stringify({ clients, personalities, people, assignments, sheets }, null, 2));

  const client = await p.client.findFirst({ where: { name: CLIENT } });
  if (!client) {
    console.log(`\nno client named ${CLIENT}`);
    await p.$disconnect();
    return;
  }

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  console.log(`\n== client "${CLIENT}" (${client.id}) ==`);
  for (const pers of await p.personality.findMany({
    where: { clientId: client.id },
    include: { accounts: { orderBy: { label: 'asc' } } },
    orderBy: { name: 'asc' },
  })) {
    const ppl = await p.person.count({ where: { personalityId: pers.id } });
    console.log(`\npersonality ${pers.name} ${pers.id}  people=${ppl}`);
    for (const a of pers.accounts) {
      const states = await p.assignment.groupBy({
        by: ['state'],
        where: { accountId: a.id },
        _count: { _all: true },
      });
      const byState =
        states.map((s) => `${s.state}=${s._count._all}`).join(' ') || '(no assignments)';
      // What claim() would really hand out: queued AND not already counted today.
      const claimable = await p.assignment.count({
        where: {
          accountId: a.id,
          state: 'queued',
          OR: [{ handedOutAt: null }, { handedOutAt: { lt: since } }],
        },
      });
      const usedToday = await p.assignment.count({
        where: { accountId: a.id, handedOutAt: { gte: since } },
      });
      const sh = await p.sheet.groupBy({
        by: ['status'],
        where: { accountId: a.id },
        _count: { _all: true },
      });
      console.log(`  ${a.label} ${a.id}`);
      console.log(`    ${byState}`);
      console.log(
        `    claimableNow=${claimable} usedToday=${usedToday} cap=${a.dailyCap} ` +
          `remaining=${Math.max(0, a.dailyCap - usedToday)}`,
      );
      console.log(
        `    sheets: ${sh.map((s) => `${s.status}=${s._count._all}`).join(' ') || '(none)'}`,
      );
    }
  }
  await p.$disconnect();
})();
