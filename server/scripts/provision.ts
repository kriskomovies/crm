/**
 * Local wrapper. The implementation lives in src/cli/provision.ts so that
 * `nest build` compiles it into the runtime image -- scripts/ is outside
 * tsconfig's include, and the image installs --omit=dev, so neither this file
 * nor ts-node exists in the container.
 *
 *   here        npx ts-node scripts/provision.ts --client "..." ...
 *   container   docker compose exec api node dist/cli/provision.js --client "..." ...
 */
import { PrismaClient } from '@prisma/client';

import { main } from '../src/cli/provision';

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => new PrismaClient().$disconnect());
