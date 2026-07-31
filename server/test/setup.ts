/**
 * The integration suite runs against the dev Postgres cluster on
 * 127.0.0.1:5433, not against a mock and not against a throwaway schema.
 *
 * That is the point of it: the two things it exists to prove -- that
 * `UNIQUE (personalityId, handle)` is scoped per personality, and that the
 * FOR UPDATE SKIP LOCKED handout behaves under concurrent claims -- are
 * properties of Postgres, and any test double that answered them would be
 * asserting its own implementation.
 *
 * @prisma/client reads server/.env when it is first required, so DATABASE_URL
 * arrives on its own. It is checked here anyway: run from the wrong directory
 * the failure is otherwise a connection error inside the first `beforeAll`,
 * which reads like the database is down.
 */
import 'reflect-metadata';

process.env.STORAGE_DRIVER ??= 'local';

// Pinned, not defaulted, because server/.env legitimately carries
// QUEUE_DRIVER=inline on a box with no Redis -- and inline makes the upload run
// the pipeline in-process instead of enqueueing. The e2e suite asserts the
// enqueue contract, so a developer's local convenience silently turned nine
// passing tests into nine failures that looked like a path problem. What the
// suite covers must not depend on which machine it runs on.
process.env.QUEUE_DRIVER = 'queue';

// Requiring the client is what loads .env, so this import must come first.
require('@prisma/client');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is unset. Run the integration suite from server/, where .env is.',
  );
}
