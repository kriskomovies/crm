/**
 * End-to-end smoke test of the ported extraction path, with no database.
 *
 * Runs the real contact sheet through the TypeScript gateway client, prompt and
 * parser, then applies the same normalisation and filter logic the pipeline
 * uses, and scores the handles against vlm_eval/ground_truth.json.
 *
 * The point is to prove the PORT, not the model: Python already scores 99/99 on
 * this image, so anything less here is a bug introduced in translation.
 *
 *   npx ts-node scripts/smoke-extract.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GatewayClient } from '../src/extraction/gateway.client';
import {
  cleanDisplayName,
  combinePresents,
  isPlausibleHandle,
  normCountry,
  normHandle,
  signalsDisagree,
  toPresents,
} from '../src/extraction/normalize';
import { priceUsd, usdPer1000Profiles } from '../src/extraction/pricing';
import { distinctCuesRatio, extractJson, sheetPrompt } from '../src/extraction/sheet-task';

const ROOT = join(__dirname, '..', '..');
const SHEET = join(ROOT, 'test', 'main', 'all99_3col.png');
const GT = join(ROOT, 'vlm_eval', 'ground_truth.json');

if (!process.env.APIMART_API_KEY) {
  process.env.APIMART_API_KEY = readFileSync(
    join(ROOT, 'vlm_eval', '.apimart_key'),
    'utf8',
  ).trim();
}

function groundTruth(): Map<string, string> {
  const gt = JSON.parse(readFileSync(GT, 'utf8'));
  const out = new Map<string, string>();
  for (const page of Object.keys(gt.pages).sort()) {
    for (const row of gt.pages[page]) {
      const h = normHandle(row.handle);
      if (!out.has(h)) out.set(h, row.gender_presentation ?? '');
    }
  }
  return out;
}

async function main(): Promise<void> {
  const model = process.argv[2] ?? 'gemini-3.6-flash';
  const image = readFileSync(SHEET);
  const dataUri = `data:image/png;base64,${image.toString('base64')}`;
  console.log(`sheet  ${SHEET}  (${(image.length / 1024).toFixed(0)} KB)`);
  console.log(`model  ${model}\n`);

  const started = Date.now();
  const res = await new GatewayClient().ask({
    model,
    prompt: sheetPrompt(99),
    images: [dataUri],
  });

  const { entries, salvaged } = extractJson(res.text);
  const usd = priceUsd(model, res.promptTokens, res.completionTokens);
  console.log(
    `${res.seconds.toFixed(1)}s  in=${res.promptTokens} out=${res.completionTokens} ` +
      `image=${res.imageTokens ?? '?'}  finish=${res.finishReason}`,
  );
  console.log(
    `parsed ${entries.length}/99${salvaged ? ' (SALVAGED from a truncated reply)' : ''}` +
      `  cost $${usd.toFixed(4)}  = $${usdPer1000Profiles(model, res.promptTokens, res.completionTokens, entries.length).toFixed(3)}/1000 profiles`,
  );
  const cues = distinctCuesRatio(entries);
  if (cues !== null) console.log(`distinct cues ${cues.toFixed(2)}`);

  // Same normalisation the pipeline applies before anything reaches the ledger.
  const key = groundTruth();
  let exact = 0;
  let rejected = 0;
  let manBucket = 0;
  let womenInBucket = 0;
  let conflicts = 0;
  const misses: string[] = [];

  for (const e of entries) {
    const handle = normHandle(e.handle);
    if (!isPlausibleHandle(handle)) {
      rejected++;
      continue;
    }
    if (key.has(handle)) exact++;
    else misses.push(`${handle} (${cleanDisplayName(e.display_name)})`);

    const avatar = toPresents(e.avatar_presents_as);
    const name = toPresents(e.name_presents_as);
    if (signalsDisagree(avatar, name)) {
      conflicts++;
      continue; // dropped by the filter, never forwarded
    }
    if (combinePresents(avatar, name) === 'man') {
      manBucket++;
      if (key.get(handle) === 'woman') womenInBucket++;
    }
  }

  console.log(`\nhandles exact against ground_truth.json   ${exact}/99`);
  console.log(`rejected as implausible handles           ${rejected}`);
  console.log(`avatar/name conflicts dropped             ${conflicts}`);
  console.log(
    `man bucket ${manBucket}, of which women ${womenInBucket}` +
      (manBucket ? ` (${((womenInBucket / manBucket) * 100).toFixed(1)}%)` : ''),
  );
  if (misses.length) {
    console.log(`\nhandles not in the key:`);
    for (const m of misses.slice(0, 8)) console.log(`  ${m}`);
  }

  const countries = new Map<string, number>();
  for (const e of entries) {
    const c = normCountry(e.nationality);
    if (c) countries.set(c, (countries.get(c) ?? 0) + 1);
  }
  const top = [...countries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`\norigin calls: ${top.map(([c, n]) => `${c}=${n}`).join(', ')}`);
  console.log(`total elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

void main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
