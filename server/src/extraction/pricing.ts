/**
 * Token prices, ported from vlm_eval/pricing.py.
 *
 * The gateway publishes ratios rather than dollars at /api/pricing, where the
 * unit is $2 per million tokens per unit of ratio:
 *
 *   input  $/M = model_ratio * 2
 *   output $/M = model_ratio * completion_ratio * 2
 *
 * The table below is the cached result for the models this service actually
 * uses, so a request never blocks on a pricing lookup. `refresh()` re-reads the
 * gateway when a price changes.
 *
 * gemini-3.6-flash publishes `model_ratio: 0`, which means UNLISTED, not free.
 * Its price was solved from a real bill instead -- $0.66 across 13 calls
 * totalling 18,423 input and 104,522 output tokens -- giving $1.02/M in and
 * $6.13/M out. Output is 98% of the cost, so the in/out split assumption barely
 * matters: solving on output alone lands within 3%.
 */
export interface TokenPrice {
  inPerM: number;
  outPerM: number;
  /** True when the figure was derived from a bill, not published by the gateway. */
  measured?: boolean;
}

export const PRICES: Record<string, TokenPrice> = {
  'gemini-3.6-flash': { inPerM: 1.02, outPerM: 6.13, measured: true },
  // FITTED FROM ONE RUN, not solved from a bill like the row above, and that is
  // the difference `measured: false` is recording.
  //
  // vlm_eval/FORMAT-AB.md, arm V1: 1,904 prompt + 7,459 completion tokens billed
  // $0.0233/sheet. vlm_eval/pricing.py:81 publishes $0.40/$2.40 for this model,
  // which predicts (1904*0.40 + 7459*2.40)/1e6 = $0.0187 against that -- about
  // 20% light against a real charge -- so it is not copied. Input is held at the
  // published $0.40/M and output solved for the remainder:
  //   ($0.0233 - 1904*0.40/1e6) / 7459 * 1e6 = $3.02/M
  // which reproduces $0.02329/sheet and $0.235/1000 profiles against the
  // document's $0.236. One run is not a bill: re-derive with
  // vlm_eval/measure_models.py before anyone quotes this number at a client.
  //
  // Residual worth knowing: refresh() below replaces any row the gateway
  // publishes a non-zero ratio for, and it keeps measured values only where the
  // gateway publishes nothing (see the `continue` at the unlisted branch). If
  // apimart ever lists this model, this fitted row is replaced by the published
  // one we already know is 20% light. That is the documented policy rather than
  // a bug, but it is the one row where the policy loses accuracy.
  'gemini-3-flash-preview-nothinking': { inPerM: 0.4, outPerM: 3.02, measured: false },
  'gemini-3-pro-preview': { inPerM: 2.0, outPerM: 12.0 },
  'gemini-3.5-flash': { inPerM: 1.5, outPerM: 9.0 },
  'gemini-2.5-flash': { inPerM: 0.3, outPerM: 2.5 },
  'gemini-2.5-flash-lite': { inPerM: 0.1, outPerM: 0.4 },
  'gpt-4.1-mini': { inPerM: 0.4, outPerM: 1.6 },
  'gpt-4.1': { inPerM: 2.0, outPerM: 8.0 },
  'gpt-5.4-mini': { inPerM: 0.75, outPerM: 4.5 },
  'gpt-5.1': { inPerM: 1.25, outPerM: 10.0 },
  'claude-sonnet-4-6': { inPerM: 3.0, outPerM: 15.0 },
  'kimi-k2.5': { inPerM: 0.51, outPerM: 0.69 },
};

/** Dollars for one call. Unknown models price at 0 rather than throwing --
 * losing cost telemetry must never fail an extraction. */
export function priceUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (promptTokens * p.inPerM + completionTokens * p.outPerM) / 1e6;
}

/** Cost of reading 1000 profiles, the unit that actually decides model choice. */
export function usdPer1000Profiles(
  model: string,
  promptTokens: number,
  completionTokens: number,
  profiles: number,
): number {
  if (profiles <= 0) return 0;
  return (priceUsd(model, promptTokens, completionTokens) / profiles) * 1000;
}

const UNIT_PER_M = 2.0;

/** Re-read the gateway's ratio table. Published prices win; measured entries
 * are kept only where the gateway still publishes nothing. */
export async function refresh(apiKey: string, baseUrl = 'https://api.apimart.ai'): Promise<void> {
  const res = await fetch(`${baseUrl}/api/pricing`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return;
  const body = (await res.json()) as { data?: any[] };
  for (const m of body.data ?? []) {
    const ratio = Number(m.model_ratio) || 0;
    if (!ratio) continue; // unlisted: keep whatever measured value we have
    const completion = Number(m.completion_ratio) || 1;
    const discount = Number(m.discount_rate) || 1;
    PRICES[m.model_name] = {
      inPerM: ratio * UNIT_PER_M * discount,
      outPerM: ratio * completion * UNIT_PER_M * discount,
    };
  }
}
