// node scripts/sheets-for-account.js <accountId>
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rows = await p.sheet.findMany({
    where: { accountId: process.argv[2] },
    select: { id: true, status: true, sha256: true, receivedAt: true, error: true },
    orderBy: { receivedAt: 'asc' },
  });
  for (const s of rows) {
    console.log(`${s.id} ${s.status.padEnd(11)} ${s.sha256} ${s.receivedAt.toISOString()} ${s.error ?? ''}`);
  }
  await p.$disconnect();
})();
