/**
 * The price rows, and the one that is fitted rather than billed.
 *
 * A wrong price does not fail anything. priceUsd() cannot throw -- an unknown
 * model answers 0 so that losing cost telemetry never fails an extraction -- so
 * every mistake in this file surfaces as a spend column that looks fine and a
 * monthly budget that does not bind. There is no runtime symptom to notice, and
 * that is the whole reason the arithmetic is pinned here against the token
 * counts and the dollar figure from the run it was derived from.
 *
 * Numbers below come from vlm_eval/FORMAT-AB.md, arm V1: one call, 1,904 prompt
 * tokens (1,100 of them image tokens) and 7,459 completion tokens, billed
 * $0.0233 for the sheet and reported at $0.236 per 1000 profiles over 99 people.
 */
import { describe, expect, it } from 'vitest';

import { EXTRACTION_MODELS } from './models';
import { PRICES, priceUsd, usdPer1000Profiles } from './pricing';

const NOTHINKING = 'gemini-3-flash-preview-nothinking';

/** The measured V1 call. */
const PROMPT_TOKENS = 1904;
const COMPLETION_TOKENS = 7459;
const BILLED_USD_PER_SHEET = 0.0233;
const PROFILES_PER_SHEET = 99;

describe('the fitted nothinking row', () => {
  it('prices the measured call to within 0.5% of what it was billed', () => {
    const priced = priceUsd(NOTHINKING, PROMPT_TOKENS, COMPLETION_TOKENS);
    // 0.5%, not "toBeCloseTo": the bill is quoted to four decimal places, so a
    // tighter bound would be asserting precision the source does not have, and a
    // looser one would pass for the published rate this row exists to replace.
    expect(Math.abs(priced - BILLED_USD_PER_SHEET) / BILLED_USD_PER_SHEET).toBeLessThan(0.005);
  });

  it('reproduces the per-1000-profiles figure the same run reported', () => {
    const per1000 = usdPer1000Profiles(
      NOTHINKING,
      PROMPT_TOKENS,
      COMPLETION_TOKENS,
      PROFILES_PER_SHEET,
    );
    // $0.236 in the document; the fit lands at $0.235, a rounding step away.
    expect(Math.abs(per1000 - 0.236) / 0.236).toBeLessThan(0.01);
  });

  it('is meaningfully dearer than the published rate it deliberately ignores', () => {
    // vlm_eval/pricing.py publishes $0.40/$2.40 for this model. Copying it would
    // have priced the same call at $0.0187 against a $0.0233 charge -- 20%
    // light, every call, forever. This asserts the gap is real and that nobody
    // has quietly "corrected" the row back to the published number.
    const published = (PROMPT_TOKENS * 0.4 + COMPLETION_TOKENS * 2.4) / 1e6;
    expect(published / BILLED_USD_PER_SHEET).toBeLessThan(0.85);
    expect(priceUsd(NOTHINKING, PROMPT_TOKENS, COMPLETION_TOKENS)).toBeGreaterThan(published);
  });

  it('is marked as not measured, because one run is not a bill', () => {
    // gemini-3.6-flash's row was solved from a real invoice across 13 calls and
    // carries measured: true. This one is fitted from a single run, and the flag
    // is what tells them apart when someone quotes a figure at a client.
    expect(PRICES[NOTHINKING].measured).toBe(false);
    expect(PRICES['gemini-3.6-flash'].measured).toBe(true);
  });

  it('still prices the cheap model well below the one it is an alternative to', () => {
    // The trade the settings screen describes: ~5x cheaper for two more women
    // leaked out of five. If this ratio ever collapses, the copy on that screen
    // is wrong and someone has to rewrite it.
    const cheap = priceUsd(NOTHINKING, PROMPT_TOKENS, COMPLETION_TOKENS);
    const dear = priceUsd('gemini-3.6-flash', PROMPT_TOKENS, 16719);
    expect(dear / cheap).toBeGreaterThan(4);
  });
});

describe('every selectable model', () => {
  it('has a price row', () => {
    // models.ts asserts this at import and refuses to boot without it, so this
    // test would already have failed on the import above. Restated as an
    // assertion anyway: a boot-time throw inside a module nobody imports in a
    // unit run is a guard that is only as good as the import graph.
    for (const model of EXTRACTION_MODELS) {
      expect(PRICES[model], `no price row for ${model}`).toBeDefined();
    }
  });

  it('is a model an extraction would actually be trusted from', () => {
    // Not derived from PRICES, and this is the pin on that. gpt-4.1-mini has a
    // price row and emitted one avatar description for 94 of 99 faces, so every
    // sheet it reads is discarded by the distinct-cues guard. Priced is not fit.
    expect(EXTRACTION_MODELS).not.toContain('gpt-4.1-mini');
  });
});

describe('an unpriced model', () => {
  it('costs 0 rather than throwing', () => {
    // Deliberate: losing cost telemetry must never fail an extraction. It is
    // also exactly why models.ts refuses to boot with an unpriced SELECTABLE
    // model -- this silence is survivable for a model nobody chose and is a
    // zeroed spend column for one somebody did.
    expect(priceUsd('not-a-model', 1000, 1000)).toBe(0);
    expect(usdPer1000Profiles('not-a-model', 1000, 1000, 99)).toBe(0);
  });
});
