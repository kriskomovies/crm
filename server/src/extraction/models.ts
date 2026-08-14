/**
 * The models an operator may select, and why the list is closed.
 *
 * Client.extractionModel goes straight to the gateway as the model name
 * (PipelineService.extract passes it through untouched), so an unknown string
 * does not fail validation and does not fail loudly -- it fails EVERY extraction
 * for that client, one gateway error per uploaded sheet, with nothing on the
 * settings screen to suggest the model name is the cause. A free-text field here
 * is a typo that silently switches a client off.
 *
 * NOT derived from PRICES. That is a price table, and it carries models that
 * must never be selectable: gpt-4.1-mini has a price row and emitted ONE avatar
 * description for 94 of 99 faces, so every sheet it reads is thrown away by the
 * distinct-cues guard. Being priced is not being fit to run.
 *
 * Two entries, because two is what has been measured end to end against the
 * keyed 99 (vlm_eval/FORMAT-AB.md). Adding a third means measuring it first.
 */
import { PRICES } from './pricing';

export const EXTRACTION_MODELS = [
  // First in the list because it is the default, and the cheap one -- see the
  // trade-off the settings screen prints next to the field. At production
  // geometry (99 entries per sheet, which is what the pipeline sends) it leaks
  // 3 of the 5 women in the keyed sample where 3.6-flash leaks 1, for
  // $0.0233/sheet against $0.1282.
  'gemini-3-flash-preview-nothinking',
  // What every existing client is on. 1 of 5 leaked, and 5.5x the money.
  'gemini-3.6-flash',
] as const;

export type ExtractionModel = (typeof EXTRACTION_MODELS)[number];

/**
 * Checked at boot rather than written down in a comment.
 *
 * priceUsd() answers 0 for a model it has no row for, deliberately -- losing
 * cost telemetry must never fail an extraction. The cost of that decision is
 * that a SELECTABLE model with no price row books every extraction at
 * $0.000000: the spend column reads healthy, the monthly budget never binds, and
 * the first evidence is the invoice. Refusing to boot is the only place that is
 * loud enough, and it fires the moment someone adds a model to the list above
 * without adding its price.
 */
for (const model of EXTRACTION_MODELS) {
  if (!PRICES[model]) {
    throw new Error(
      `no price row for selectable extraction model "${model}" -- ` +
        'add it to PRICES in extraction/pricing.ts, or every extraction that ' +
        'uses it books at $0 and the budget cap never binds',
    );
  }
}
