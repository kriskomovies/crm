/**
 * Recorded VLM replies, and where every one of them came from.
 *
 * The e2e suite stubs exactly one thing: the HTTP call to the gateway. What that
 * call returns therefore decides what the whole pipeline is tested against, and
 * a reply somebody wrote by hand tests the handwriting, not the parser. So none
 * of these were written. They are real answers real models gave to the real
 * prompt over `test/main/all99_3col.png`, harvested from two places:
 *
 *   - the dev database, where Extraction.rawReply keeps the gateway's answer
 *     verbatim (see the sha256 below -- those rows are that exact image);
 *   - vlm_eval/results/*.json, where the eval harness stored `calls[].raw`,
 *     which is the same thing: the model's untouched text, fence and all.
 *
 * Two fixtures are derived rather than copied, and both say so and say how.
 * Nothing here invents a handle, a display name or a description.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** sha256 of test/main/all99_3col.png. Every reply below is an answer to it. */
export const SHEET_SHA256 =
  'a3807427444b5a0e556e37b879ad5d1078b854dd5eaa08e735a65a9c0cf4eff4';

export interface RecordedReply {
  /** Verbatim model text, exactly as the gateway delivered it. */
  text: string;
  /** The model that produced it -- also what its cost is priced against. */
  model: string;
  promptTokens: number;
  completionTokens: number;
  seconds: number;
  /** Where it was harvested from, and what it is here to prove. */
  provenance: string;
}

function load(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

/**
 * The golden run: 99 entries, and its 99 handles are exactly the 99 unique
 * handles in vlm_eval/ground_truth.json. A known-perfect answer, so the journey
 * test is a golden-file test -- any drift in normalisation, parsing or the
 * handle regex shows up as a diff against the scoring key rather than as a
 * number that quietly moved.
 *
 * It also carries one real avatar/name disagreement (@kylee258082, avatar reads
 * man, name reads woman), which is the review rule the product is sold on, and
 * three not-a-person avatars.
 */
export const GOLDEN_99: RecordedReply = {
  text: load('golden-99.reply.txt'),
  model: 'gemini-3.6-flash',
  promptTokens: 1718,
  completionTokens: 13125,
  seconds: 46.372,
  provenance:
    'dev DB, extractions.id=50e1b4ad-a1bd-444e-a778-27c2267007ea, gemini-3.6-flash over all99_3col.png. ' +
    '99/99 against vlm_eval/ground_truth.json.',
};

/**
 * The second real run over the same image with the same model. Agrees with the
 * golden run on all 99 handles and differs only in emoji on 8 display names --
 * which is what "the same sheet uploaded twice" really looks like, and why the
 * dedupe assertion is worth making against a re-read rather than a byte copy.
 */
export const GOLDEN_99_RERUN: RecordedReply = {
  text: load('golden-99-rerun.reply.txt'),
  model: 'gemini-3.6-flash',
  promptTokens: 1718,
  completionTokens: 15015,
  seconds: 92.883,
  provenance:
    'dev DB, extractions.id=c6d4e726-f310-449b-a6f7-0bd8045c06e5, second gemini-3.6-flash run over the same image.',
};

/**
 * claude-haiku reading the same image. It reads entry 41 as `timetogotowatch`;
 * every other model, and the scoring key, read `timetogotawatch`. Both under the
 * display name "Matt". That is the real misread the near-duplicate guard was
 * built for, not a constructed one -- one dropped character between two
 * independent extractions of ONE image, which without the guard is two ledger
 * rows for one human and two accounts told to follow him.
 *
 * It arrives wrapped in a ```json fence, so it exercises the fence path in
 * extractJson at the same time.
 */
export const HAIKU_TWIN: RecordedReply = {
  text: load('haiku-twin.reply.txt'),
  model: 'claude-haiku-4-5-20251001',
  promptTokens: 1656,
  completionTokens: 4101,
  seconds: 27.64,
  provenance:
    'vlm_eval/results/sheet_claude-haiku-4-5-20251001_r33.json, calls[0].raw. ' +
    'Carries timetogotowatch/"Matt" against the golden run s timetogotawatch/"Matt".',
};

/**
 * gpt-5.4-nano reading the same image. Four of its 99 handles are unusable:
 * `johnnywalker n` (a space), `towmaterrrrrrrrr` (16 characters, one over the
 * limit), `ifloyd1'112` (an apostrophe) and `` (it gave up and returned empty).
 * Real transcription noise, so the "skip the bad ones, keep the rest" path is
 * measured against what a model actually does rather than against invented
 * garbage.
 */
export const NANO_IMPLAUSIBLE: RecordedReply = {
  text: load('nano-implausible.reply.txt'),
  model: 'gpt-5.4-nano',
  promptTokens: 2276,
  completionTokens: 3040,
  seconds: 162.68,
  provenance:
    'vlm_eval/results/sheet_gpt-5.4-nano_r33.json, calls[0].raw. 95 of 99 handles usable.',
};

/**
 * The templated reply -- the one the distinctCuesRatio guard exists for.
 *
 * DERIVED, and here is the derivation. gpt-4.1-mini's avatar pass emitted the
 * identical sentence "short hair, no lashes, thin lips, thick eyebrows, no
 * facial hair" for 94 of 99 faces while labelling everything "man"; that run saw
 * an avatars-only crop and so carries no handles. Its `cues` and `presents_as`
 * are joined here, by entry number, onto the handles and names of the golden run
 * over the same image in the same reading order -- which is what the opt-in
 * avatar pass produces once it is merged back into the sheet reply. Both halves
 * are verbatim model output; only the join is ours.
 *
 * The join matters for the test: without handles the sheet would produce no
 * people anyway, and "no people were created" would prove nothing. With them,
 * the reply is confident, well-formed and carries 99 perfectly good handles, and
 * the guard has to refuse it anyway. Measured ratio: 0.04.
 */
export const TEMPLATED_CUES: RecordedReply = {
  text: load('templated-cues.reply.txt'),
  model: 'gpt-4.1-mini',
  promptTokens: 1422,
  completionTokens: 3464,
  seconds: 45.49,
  provenance:
    'cues+presents_as verbatim from vlm_eval/results/avatars_gpt-4.1-mini_cues_x1.json, ' +
    'joined by entry number onto the handles of the golden DB run over the same image. ' +
    'distinctCuesRatio 0.04.',
};

/** Where GOLDEN_99 is cut off. Entries 1-80 survive whole; 81 stops mid-handle. */
const TRUNCATE_AFTER_ENTRY = 81;
export const TRUNCATED_COMPLETE_ENTRIES = 80;

/**
 * The golden reply cut off mid-array, as a max_tokens stop leaves it.
 *
 * Derived rather than harvested because the corpus holds no truncated SHEET
 * reply -- the one real `finish_reason: "length"` in it
 * (avatars_gemini-2.5-flash_cues_x1.json) is an avatar pass with no handles, so
 * nothing downstream of the parse would be observable. The cut is the only edit:
 * every character before it is the golden run's own output, and the offset is
 * found by searching rather than hard-coded so it stays right if the fixture is
 * ever re-harvested.
 */
export function truncatedGolden(): RecordedReply {
  const marker = `{"n": ${TRUNCATE_AFTER_ENTRY},`;
  const at = GOLDEN_99.text.indexOf(marker);
  if (at < 0) throw new Error(`golden fixture no longer contains ${marker}`);
  // Far enough past the marker to be plainly mid-object, not short enough to
  // look like a clean end of array.
  return {
    ...GOLDEN_99,
    text: GOLDEN_99.text.slice(0, at + 70),
    // Truncation is the model stopping early, so it billed for less.
    completionTokens: Math.round(
      GOLDEN_99.completionTokens * (TRUNCATED_COMPLETE_ENTRIES / 99),
    ),
    provenance: `${GOLDEN_99.provenance} Cut mid-entry-${TRUNCATE_AFTER_ENTRY}; ${TRUNCATED_COMPLETE_ENTRIES} complete entries survive.`,
  };
}

/**
 * The 99 unique handles in vlm_eval/ground_truth.json -- the scoring key, built
 * by reading the pixels at high zoom rather than by trusting any model.
 *
 * The key has 122 rows across 9 overlapping pages of 14; deduping by handle
 * leaves 99, which is what one contact sheet holds.
 */
export function groundTruthHandles(): string[] {
  const path = join(__dirname, '..', '..', '..', 'vlm_eval', 'ground_truth.json');
  const gt = JSON.parse(readFileSync(path, 'utf8')) as {
    pages: Record<string, { handle: string; display_name: string }[]>;
  };
  const seen = new Set<string>();
  for (const page of Object.values(gt.pages)) {
    for (const row of page) seen.add(row.handle.trim().toLowerCase().replace(/^@+/, ''));
  }
  return [...seen].sort();
}
