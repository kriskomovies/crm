/**
 * The two rows test/fixtures.ts has no helper for: a sheet, and the extraction
 * that bills it.
 *
 * Deliberately additive rather than a second fixture system -- clients,
 * personalities, accounts, people and assignments all still come from
 * ../fixtures, and cleanup is still that module's `dropFixtures`, which cascades
 * from the client and so takes these rows with it.
 *
 * They exist because two of the HTTP contracts cannot be exercised without a
 * sheet: GET /api/sheets is a list endpoint that has to prove its envelope on
 * non-empty data, and /api/stats rolls cost up through Sheet -> Extraction, so a
 * tenant-isolation test that never creates one is only testing that zero equals
 * zero.
 */
import { randomUUID } from 'node:crypto';

import { prisma } from '../fixtures';

export interface SeededSheet {
  id: string;
  usd: number;
  profilesFound: number;
}

export async function addSheet(
  accountId: string,
  opts: { usd?: number; profilesFound?: number; model?: string } = {},
): Promise<SeededSheet> {
  const usd = opts.usd ?? 0.01;
  const profilesFound = opts.profilesFound ?? 9;
  const sheet = await prisma.sheet.create({
    data: {
      accountId,
      // Unique per account in the schema; a uuid keeps concurrent runs and
      // repeat calls from colliding on it.
      sha256: randomUUID().replace(/-/g, '').repeat(2),
      storageKey: `test/${randomUUID()}.png`,
      status: 'extracted',
      extraction: {
        create: {
          model: opts.model ?? 'gemini-3.6-flash',
          promptTokens: 1000,
          completionTokens: 500,
          usd,
          seconds: 12.5,
          // Stored verbatim in production and never read by these tests; kept
          // small so the row is cheap.
          rawReply: { profiles: [] },
          profilesFound,
          distinctCuesRatio: 0.9,
        },
      },
    },
    select: { id: true },
  });
  return { id: sheet.id, usd, profilesFound };
}
