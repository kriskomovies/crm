/**
 * Client for the api.apimart.ai gateway (OpenAI-compatible /v1/chat/completions).
 *
 * Ported from vlm_eval/apimart.py. Three behaviours in here were expensive to
 * discover and are not guessable from the gateway's docs -- if this file is ever
 * rewritten, keep them:
 *
 *  1. IT ALWAYS STREAMS. The endpoint answers `text/event-stream` whether or not
 *     `stream: true` was sent. Parsing the body as one JSON object fails for
 *     EVERY model, which presents as "all 29 models are broken at once" rather
 *     than as a parsing bug. The reply has to be reassembled from `data:` chunks.
 *
 *  2. Usage totals, including image token counts, arrive only in the FINAL
 *     chunk -- after `finish_reason`. Stop reading early and cost accounting
 *     silently reports zero.
 *
 *  3. Models disagree about which optional parameters exist. Reasoning models
 *     reject `temperature`; some want `max_completion_tokens` instead of
 *     `max_tokens`. Rather than withholding parameters from everyone, a quirk is
 *     learned from the error text and the call retried -- so a new model works
 *     on its second attempt instead of needing a code change.
 */
import { Injectable, Logger } from '@nestjs/common';

export interface AskResult {
  text: string;
  seconds: number;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  imageTokens: number | null;
  quirks: string[];
}

export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 400)}`);
  }
}

/** Learned per model id, process-wide: a quirk found once need not be refound. */
const quirkCache = new Map<string, Set<string>>();

export interface AskOptions {
  model: string;
  prompt: string;
  /** data: URIs. */
  images: string[];
  temperature?: number | null;
  maxTokens?: number | null;
  retries?: number;
  timeoutMs?: number;
}

@Injectable()
export class GatewayClient {
  private readonly log = new Logger(GatewayClient.name);
  private readonly base =
    process.env.APIMART_BASE_URL ?? 'https://api.apimart.ai/v1';
  private readonly apiKey = process.env.APIMART_API_KEY ?? '';

  constructor() {
    if (!this.apiKey) {
      this.log.warn('APIMART_API_KEY is not set; extraction will fail');
    }
  }

  private quirks(model: string): Set<string> {
    let q = quirkCache.get(model);
    if (!q) {
      q = new Set<string>();
      quirkCache.set(model, q);
    }
    return q;
  }

  private buildBody(o: AskOptions): Record<string, unknown> {
    const q = this.quirks(o.model);
    const content: unknown[] = [{ type: 'text', text: o.prompt }];
    for (const url of o.images) {
      content.push({ type: 'image_url', image_url: { url } });
    }
    const body: Record<string, unknown> = {
      model: o.model,
      messages: [{ role: 'user', content }],
      stream: true,
    };
    const temperature = o.temperature ?? 0;
    if (!q.has('no-temperature') && temperature !== null) {
      body.temperature = temperature;
    }
    const maxTokens = o.maxTokens ?? 32000;
    if (!q.has('no-max-tokens') && maxTokens) {
      body[
        q.has('max-completion-tokens') ? 'max_completion_tokens' : 'max_tokens'
      ] = maxTokens;
    }
    return body;
  }

  async ask(o: AskOptions): Promise<AskResult> {
    const retries = o.retries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${this.base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(this.buildBody(o)),
          signal: AbortSignal.timeout(o.timeoutMs ?? 300_000),
        });
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw err;
      }

      if (!res.ok) {
        const body = await res.text();
        const err = new GatewayHttpError(res.status, body);
        lastError = err;
        // Learn the quirk from the complaint, then retry immediately. This is
        // why an unfamiliar model works on attempt 2 rather than needing code.
        const low = body.toLowerCase();
        const q = this.quirks(o.model);
        if (low.includes('temperature') && !q.has('no-temperature')) {
          q.add('no-temperature');
          continue;
        }
        if (
          low.includes('max_completion_tokens') &&
          !q.has('max-completion-tokens')
        ) {
          q.add('max-completion-tokens');
          continue;
        }
        if (low.includes('max_tokens') && !q.has('no-max-tokens')) {
          q.add('no-max-tokens');
          continue;
        }
        if (
          [429, 500, 502, 503, 504].includes(res.status) &&
          attempt < retries
        ) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw err;
      }

      const parsed = await this.readStream(res);
      const seconds = (Date.now() - started) / 1000;

      if (!parsed.text.trim()) {
        lastError = new Error(
          `empty reply (finish=${parsed.finishReason ?? 'none'})`,
        );
        if (parsed.error) lastError = new Error(parsed.error);
        if (attempt < retries) continue;
        throw lastError;
      }

      return {
        text: parsed.text,
        seconds,
        finishReason: parsed.finishReason,
        promptTokens: parsed.promptTokens,
        completionTokens: parsed.completionTokens,
        imageTokens: parsed.imageTokens,
        quirks: [...this.quirks(o.model)],
      };
    }
    throw lastError ?? new Error('no answer');
  }

  /**
   * Reassemble an SSE reply. Also accepts a plain JSON body, because the
   * gateway is not contractually obliged to keep streaming and a future change
   * back to normal responses should not take extraction down.
   */
  private async readStream(res: Response) {
    const raw = await res.text();
    const contentType = res.headers.get('content-type') ?? '';

    if (!contentType.includes('event-stream')) {
      const body = JSON.parse(raw);
      const choice = body?.choices?.[0] ?? {};
      const usage = body?.usage ?? {};
      return {
        text: contentToString(choice?.message?.content),
        finishReason: choice?.finish_reason ?? null,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        imageTokens: usage.prompt_tokens_details?.image_tokens ?? null,
        error: body?.error?.message ?? null,
      };
    }

    const parts: string[] = [];
    let finishReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let imageTokens: number | null = null;
    let error: string | null = null;

    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // a truncated chunk is not worth failing the whole reply over
      }
      if (chunk?.error?.message) error = chunk.error.message;
      if (chunk?.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
        imageTokens =
          chunk.usage.prompt_tokens_details?.image_tokens ?? imageTokens;
      }
      for (const ch of chunk?.choices ?? []) {
        finishReason = ch?.finish_reason ?? finishReason;
        const delta = ch?.delta ?? ch?.message ?? {};
        const piece = contentToString(delta?.content);
        if (piece) parts.push(piece);
      }
    }

    return {
      text: parts.join(''),
      finishReason,
      promptTokens,
      completionTokens,
      imageTokens,
      error,
    };
  }
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'object' && p && 'text' in p ? String((p as any).text ?? '') : ''))
      .join('');
  }
  return '';
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
