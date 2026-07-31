/** Shapes the server returns, and the fetch helpers. Vite proxies /api to :3000. */

export type Account = {
  id: string;
  label: string;
  dailyCap: number;
  enabled: boolean;
  handedToday: number;
  remainingToday: number;
  queued: number;
  handedOut: number;
  followed: number;
  review: number;
};

export type Personality = {
  id: string;
  name: string;
  client: string;
  model: string;
  people: number;
  accounts: Account[];
};

export type Target = {
  handle: string;
  displayName: string;
  source: 'extraction' | 'manual';
  presentsAs: string;
  avatarPresentsAs: string;
  namePresentsAs: string;
  nationality: string | null;
  nationalityConf: string | null;
  timesSeen: number;
  state: string | null;
  reason: string | null;
  account: string | null;
};

export type AttachResult = {
  added: string[];
  duplicate: string[];
  invalid: string[];
  queued: number;
};

export type Sheet = {
  id: string;
  account: string;
  status: string;
  error: string | null;
  receivedAt: string;
  profilesFound: number;
  newPeople: number;
  // A sheet that is queued, extracting or failed never reached the model, so it
  // has no timing, no cost and no model name to report.
  seconds: number | null;
  usd: number | null;
  model: string | null;
  distinctCuesRatio: number | null;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type StatsTotals = {
  sheets: number;
  profilesRead: number;
  targets: number;
  usd: number;
  promptTokens: number;
  completionTokens: number;
  followed: number;
  failed: number;
  skipped: number;
  queued: number;
  handedOut: number;
  review: number;
};

export type StatsDay = {
  date: string;
  sheets: number;
  targets: number;
  followed: number;
  usd: number;
};

export type Stats = {
  range: { from: string; to: string };
  totals: StatsTotals;
  byDay: StatsDay[];
  byPersonality: {
    id: string;
    name: string;
    targets: number;
    followed: number;
    queued: number;
    usd: number;
    sheets: number;
  }[];
  byAccount: {
    id: string;
    label: string;
    personality: string;
    dailyCap: number;
    handedToday: number;
    followed: number;
    failed: number;
    successRate: number;
  }[];
  byCountry: { nationality: string | null; count: number; forwarded: number }[];
  bySource: { extraction: number; manual: number };
  byModel: {
    model: string | null;
    sheets: number;
    usd: number;
    avgSeconds: number;
    avgProfiles: number;
  }[];
};

/**
 * Money arrives as a string whenever it has passed through a Prisma Decimal
 * without an explicit Number(), so a plain typeof check would silently zero the
 * spend columns. Anything that is not a finite number after that is a 0.
 */
export function num(v: unknown): number {
  const x = typeof v === 'string' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const rows = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.map((r) => fields(r)) : [];
const fields = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/**
 * List endpoints are moving from bare arrays to { items, nextCursor } one at a
 * time and the server is not ours to hold still. Accept either, so a screen
 * never renders `undefined.map` mid-changeover.
 */
function asPage<T>(raw: unknown): Page<T> {
  if (Array.isArray(raw)) return { items: raw as T[], nextCursor: null };
  const o = fields(raw);
  return {
    items: Array.isArray(o.items) ? (o.items as T[]) : [],
    nextCursor: strOrNull(o.nextCursor),
  };
}

/**
 * /api/stats is new and lands in pieces. Coercing the whole shape once here
 * means a section the server has not shipped yet, or a null where a count was
 * promised, costs an empty table instead of a blank tab.
 */
function asStats(raw: unknown): Stats {
  const r = fields(raw);
  const t = fields(r.totals);
  const src = fields(r.bySource);
  const range = fields(r.range);
  return {
    range: { from: str(range.from), to: str(range.to) },
    totals: {
      sheets: num(t.sheets),
      profilesRead: num(t.profilesRead),
      targets: num(t.targets),
      usd: num(t.usd),
      promptTokens: num(t.promptTokens),
      completionTokens: num(t.completionTokens),
      followed: num(t.followed),
      failed: num(t.failed),
      skipped: num(t.skipped),
      queued: num(t.queued),
      handedOut: num(t.handedOut),
      review: num(t.review),
    },
    byDay: rows(r.byDay).map((d) => ({
      date: str(d.date),
      sheets: num(d.sheets),
      targets: num(d.targets),
      followed: num(d.followed),
      usd: num(d.usd),
    })),
    byPersonality: rows(r.byPersonality).map((p) => ({
      id: str(p.id),
      name: str(p.name),
      targets: num(p.targets),
      followed: num(p.followed),
      queued: num(p.queued),
      usd: num(p.usd),
      sheets: num(p.sheets),
    })),
    byAccount: rows(r.byAccount).map((a) => ({
      id: str(a.id),
      label: str(a.label),
      personality: str(a.personality),
      dailyCap: num(a.dailyCap),
      handedToday: num(a.handedToday),
      followed: num(a.followed),
      failed: num(a.failed),
      successRate: num(a.successRate),
    })),
    byCountry: rows(r.byCountry).map((c) => ({
      nationality: strOrNull(c.nationality),
      count: num(c.count),
      forwarded: num(c.forwarded),
    })),
    bySource: { extraction: num(src.extraction), manual: num(src.manual) },
    byModel: rows(r.byModel).map((m) => ({
      model: strOrNull(m.model),
      sheets: num(m.sheets),
      usd: num(m.usd),
      avgSeconds: num(m.avgSeconds),
      avgProfiles: num(m.avgProfiles),
    })),
  };
}

/** fetch() rejects with this when a newer request has superseded an older one. */
export function isAbort(e: unknown): boolean {
  return fields(e).name === 'AbortError';
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  // Read as text first: a 204, a 200 with an empty body, and an error page that
  // is not JSON all reach res.json() and throw a parse error over the real one.
  const body = await res.text();
  if (!res.ok) {
    // The server sends {message} on validation failures; surfacing it beats a
    // bare status code when an operator has typed something the API rejected.
    let detail = `${res.status} ${res.statusText}`;
    try {
      const m = (JSON.parse(body) as { message?: string | string[] }).message;
      if (m) detail = Array.isArray(m) ? m.join(', ') : m;
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return (body ? JSON.parse(body) : undefined) as T;
}

export const api = {
  // Asks for a page and keeps only the items: this drives the 5s overview poll
  // and the personality filter, neither of which can page. 500 is the contract
  // ceiling and no client is anywhere near it.
  personalities: (signal?: AbortSignal) =>
    req<unknown>('/api/personalities?limit=500', { signal }).then(
      (r) => asPage<Personality>(r).items,
    ),

  createPersonality: (name: string) =>
    req<Personality>('/api/personalities', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deletePersonality: (id: string) =>
    req<void>(`/api/personalities/${id}`, { method: 'DELETE' }),

  addAccount: (id: string, label: string, dailyCap: number) =>
    req<Account>(`/api/personalities/${id}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ label, dailyCap }),
    }),

  updateAccount: (id: string, patch: { dailyCap?: number; enabled?: boolean }) =>
    req<Account>(`/api/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  targets: (
    id: string,
    opts: { q?: string; state?: string; cursor?: string } = {},
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams({ limit: '100' });
    if (opts.q) p.set('q', opts.q);
    if (opts.state) p.set('state', opts.state);
    if (opts.cursor) p.set('cursor', opts.cursor);
    return req<unknown>(`/api/personalities/${id}/targets?${p}`, { signal }).then((r) =>
      asPage<Target>(r),
    );
  },

  attach: (id: string, handles: string[]) =>
    req<AttachResult>(`/api/personalities/${id}/targets`, {
      method: 'POST',
      body: JSON.stringify({ handles, source: 'manual' }),
    }),

  sheets: (opts: { cursor?: string } = {}, signal?: AbortSignal) => {
    const p = new URLSearchParams({ limit: '100' });
    if (opts.cursor) p.set('cursor', opts.cursor);
    return req<unknown>(`/api/sheets?${p}`, { signal }).then((r) => asPage<Sheet>(r));
  },

  stats: (
    opts: { personalityId?: string; from?: string; to?: string } = {},
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams();
    if (opts.personalityId) p.set('personalityId', opts.personalityId);
    if (opts.from) p.set('from', opts.from);
    if (opts.to) p.set('to', opts.to);
    const qs = p.toString();
    return req<unknown>(`/api/stats${qs ? `?${qs}` : ''}`, { signal }).then((r) => asStats(r));
  },
};

/** Accept handles pasted one per line, comma separated, or with a leading @. */
export function parseHandles(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((h) => h.trim().replace(/^@+/, ''))
    .filter(Boolean);
}
