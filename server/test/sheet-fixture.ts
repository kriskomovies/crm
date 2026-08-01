/**
 * The 99-profile contact sheet that the e2e suite uploads.
 *
 * It is deliberately NOT in the repository. It is a photograph of ninety-nine
 * real people -- their faces, display names and handles -- and that does not
 * belong in a git history that outlives any decision to delete it. Each machine
 * that wants full e2e coverage supplies its own copy at
 * `test/main/all99_3col.png`, from `python -m client.capture` on the client
 * project plus `vlm_eval/sheet.py` to montage it.
 *
 * When the file is absent the sheet-driven specs SKIP instead of failing.
 * Reading it at module scope, as they used to, meant a missing fixture threw
 * during import and took the whole file down with an ENOENT -- a stack trace
 * that says nothing about what is wrong or how to fix it. A skip says "you do
 * not have the fixture"; a failure says "the product is broken", and conflating
 * those two is how people learn to ignore a red suite.
 *
 * `describeSheet` is plain `describe` when the fixture is present, so nothing
 * about the covered behaviour changes on a machine that has it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'vitest';

/** Repository root is two levels up from server/test. */
export const SHEET_PATH = join(
  __dirname,
  '..',
  '..',
  'test',
  'main',
  'all99_3col.png',
);

export const SHEET_PRESENT = existsSync(SHEET_PATH);

/**
 * The image bytes, or an empty buffer when it is missing. Nothing reads the
 * empty buffer: every consumer is inside a `describeSheet` block, which does
 * not run in that case.
 */
export const SHEET: Buffer = SHEET_PRESENT
  ? readFileSync(SHEET_PATH)
  : Buffer.alloc(0);

export const describeSheet = SHEET_PRESENT ? describe : describe.skip;

if (!SHEET_PRESENT) {
  // Printed once per spec file rather than swallowed, because a suite that
  // quietly reports "skipped" with no reason is indistinguishable from one
  // that was never written.
  console.warn(
    `[e2e] ${SHEET_PATH} not found -- sheet-driven specs are skipped. ` +
      'See server/test/sheet-fixture.ts for how to supply it.',
  );
}
