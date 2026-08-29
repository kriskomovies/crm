/** Shapes the server returns, and the fetch helpers. Vite proxies /api to :3000. */

export type Account = {
  id: string;
  label: string;
  /** Where this account is on the onboarding ladder: cleanup_contacts,
   *  cleanup_chats, cleanup_friends, seeding, established. A string rather than
   *  a union because the server owns the list -- see onboarding() in ui.tsx,
   *  which shows an unrecognised one verbatim instead of guessing. Nothing is
   *  handed to an account below `seeding`, which is why it is on the row. */
  phase: string;
  /** Searched adds landed so far, out of ONBOARD_TARGET (stated in ui.tsx, not
   *  sent per row). Only meaningful while `phase` is 'seeding'. */
  onboardedCount: number;
  /** The client's setting, not this account's. Edited on the Settings tab. */
  dailyCap: number;
  enabled: boolean;
  /** Cap SLOTS taken today, which is what the cap bar draws. Moves by a whole
   *  batch when an agent claims and then holds still while that batch is worked,
   *  so it is not the number to watch a run through -- followedToday is. */
  handedToday: number;
  remainingToday: number;
  queued: number;
  followed: number;
  /** Follows this account landed TODAY. The only counter on the row that a single
   *  follow moves, so it is what shows a run advancing between polls. */
  followedToday: number;
  /** Handles this personality holds that no account was ever given, because the
   *  filter dropped them. A drop leaves a person and no assignment, so this is a
   *  property of the personality and reads the same on every one of its account
   *  rows. */
  rejected: number;
  /** Followed under a SIBLING account of the same personality. One person can
   *  hold one assignment, so these are handles this account can never be given:
   *  the dedupe, counted. */
  alreadyFollowed: number;
  /** Attempts this account made TODAY that came back failed. Today-scoped, and
   *  the only column here that is -- a reported failure goes back to `queued`
   *  and is offered again on a later day, so there is no terminal `failed` row
   *  to count all-time. The name carries the scope because every other count on
   *  the row is all-time and an unmarked one sitting among them would read as
   *  all-time by adjacency. */
  failedToday: number;
};

/** What a daily-cap reset freed. Two counts because they answer two questions:
 *  `cleared` is how many of today's cap slots came back, `requeued` is how many
 *  of those rows were stuck mid-flight — claimed by a machine and never
 *  reported — and are workable again. */
/** What deleting an account cost, reported back so the screen can say it. */
export type AccountRemoved = {
  id: string;
  label: string;
  followed: number;
  queued: number;
  sheets: number;
  purged: number;
};

export type CapReset = {
  id: string;
  label: string;
  requeued: number;
  cleared: number;
  handedToday: number;
  remainingToday: number;
};

export type Personality = {
  id: string;
  name: string;
  client: string;
  model: string;
  people: number;
  /** Dropped by the filter. Personality-wide: a refusal leaves a person with
      no assignment, so it belongs to no account. */
  rejected: number;
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
  /** Both null until they happen, and a person the filter dropped never gets
   *  either. `when()` prints a missing one as an em dash rather than an
   *  Invalid Date, which is also what happens against a server that has not
   *  shipped these two yet. */
  handedOutAt: string | null;
  /** When the follow LANDED. The server calls it `followedAt` and always has;
   *  the name here used to be `resultAt`, which is the column behind it rather
   *  than the field on the wire, so every row read undefined. */
  followedAt: string | null;
  /** What the machine said when it ended the attempt -- "not reached -- the walk
   *  covered 10 page(s) of Quick Add and no row on them read as this handle" and
   *  the like. Sent since report() was written, read by nothing until now. */
  note: string | null;
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
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
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

export interface Rule {
  presentsAs: string[];
  countries: string[];
  skinTones: string[];
  minConfidence: string;
  action?: string;
  enabled?: boolean;
}

/**
 * One name-origin box. `value` is what the filter stores and compares; `count`
 * is how many people already in this client's ledger read that way, which is
 * the whole reason the list stopped being a constant -- it answers "is this
 * worth ticking" on the page instead of on the stats tab.
 *
 * `count: 0` is meaningful: the value is still saved on the rule but no longer
 * appears in the data, so the box has to stay tickable and stay marked.
 * `count: null` is the different case of a server that has not shipped the
 * dynamic list yet and told us nothing -- see `asRuleOptions`.
 */
export interface Origin {
  value: string;
  count: number | null;
}

/**
 * The sentinel for "the model could not read an origin from this name". It is
 * the literal string the API and the filter both understand; `normCountry` maps
 * that exact word to null before storage, so no real nationality can ever
 * collide with it.
 *
 * `'none'` and not `'unknown'`, which is the word the bucket is actually called
 * everywhere else. `unknown` was a chip on the OLD version of this screen, and
 * it matched nobody -- the filter needed a non-null nationality before it
 * compared anything. Reusing the string would have turned every rule still
 * carrying that dead tick into one forwarding the whole unread bucket the
 * moment the server deployed, with no operator touching the page. The old tick
 * now arrives as its own option at count 0 and renders `none now`, which is
 * exactly what it has always been worth.
 *
 * Never shown raw: the chip is labelled `no nationality read`, because the
 * value reads like the word for "nothing selected", which is the opposite of
 * what it does.
 */
export const NO_NATIONALITY = 'none';

export interface RuleOptions {
  origins: Origin[];
  presentsAs: string[];
  confidences: string[];
  skinTones: string[];
}

/**
 * `origins` changed from `string[]` to `{ value, count }[]` when the list
 * started coming from the ledger. `api.rules()` had no coercion at all, unlike
 * `asStats`, so a server still serving the old constant would put `undefined`
 * in every chip. Accept either shape.
 *
 * The old shape gets `count: null`, NOT 0: zero now means "saved on the rule,
 * absent from the data" and would tag every box as gone.
 */
function asRuleOptions(raw: unknown): RuleOptions {
  const o = fields(raw);
  return {
    origins: (Array.isArray(o.origins) ? o.origins : [])
      .map((v): Origin => {
        if (typeof v === 'string') return { value: v, count: null };
        const f = fields(v);
        return {
          value: str(f.value),
          count: f.count === undefined || f.count === null ? null : num(f.count),
        };
      })
      .filter((v) => v.value !== ''),
    presentsAs: strs(o.presentsAs),
    confidences: strs(o.confidences),
    skinTones: strs(o.skinTones),
  };
}

/** One row of the onboarding pool. `usedAt` set means it has been spent. */
export type ImportedHandle = {
  id: string;
  handle: string;
  usedAt: string | null;
  createdAt: string;
  account: string | null;
};

export type OnboardingPool = {
  total: number;
  used: number;
  available: number;
  items: ImportedHandle[];
};

/** What became of every line of a pasted file. Four counts, because "added 12"
 *  out of a fifty-line file is a question rather than an answer. */
export type ImportResult = {
  added: number;
  duplicate: number;
  invalid: string[];
  total: number;
};

/** A proxy as the emulator's dialog needs it typed: the address, and the
 *  credential pair beside it. Sent whole wherever a stock account is read,
 *  because the two are configured together. */
export type ProxyRef = {
  id: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
};

export type Proxy = ProxyRef & {
  /** Stock accounts currently behind it — the number the even spread evens. */
  accounts: number;
  createdAt: string;
};

export type ProxyPool = { total: number; items: Proxy[] };

/** One of OUR accounts, in stock. Not the software's Account above: nothing is
 *  ever handed to it and no machine knows it exists. */
export type StockAccount = {
  id: string;
  username: string;
  password: string;
  /** Set when the operator marked it installed on an emulator. */
  deployedAt: string | null;
  createdAt: string;
  proxy: ProxyRef | null;
};

export type StockPool = {
  total: number;
  assigned: number;
  deployed: number;
  items: StockAccount[];
};

/** The account paste also deals proxies, so its result carries two more
 *  counts: how many rows now sit behind one, and how many still do not
 *  (which is only ever non-zero when there are no proxies to deal). */
export type StockImportResult = ImportResult & { assigned: number; unassigned: number };

export interface Session {
  authenticated: boolean;
  client?: { id: string; name: string };
}

/** How hard to push every account. One setting for the whole client.
 *  The two caps are enforced by the server; the pace is only served. */
export interface Settings {
  dailyCapPerAccount: number;
  followPaceSeconds: number;
  /** Targets per account per rolling `sessionWindowMinutes`. Enforced in the
   *  same claim and against the same lock as the daily cap. */
  sessionCapPerAccount: number;
  /** How long that window is. It rolls -- the server cannot observe a session,
   *  so it counts what an account was handed in the last N minutes. */
  sessionWindowMinutes: number;
  /** The same two caps again, for an account still short of its first 50
   *  searched adds. They REPLACE the pair above while it is onboarding rather
   *  than stacking with it: searching exact usernames on a brand-new account is
   *  different work at a different risk. The window is shared. */
  onboardingDailyCap: number;
  onboardingSessionCap: number;
  /** Which vision model reads this client's sheets. A closed set, checked
   *  server-side: the string is handed straight to the gateway, so an unlisted
   *  one does not fail validation, it fails every extraction for this client. */
  extractionModel: string;
}

/** GET only, and deliberately not part of `Settings`: the vocabulary travels
 *  with the value the same way the rule options do, but a `models` key spread
 *  back into a PUT would be rejected by the server's whitelist. Keeping it off
 *  the saveable shape is what stops that happening by accident. */
export type SettingsRead = Settings & { models: string[] };

/**
 * One route behind two screens. The followed list is the target list with the
 * state pinned, not a second endpoint over the same rows -- a second one would
 * be a second place for the client scoping to be got wrong, and it would be the
 * one nobody looked at.
 */
function targetPage(
  id: string,
  opts: { q?: string; state?: string; cursor?: string },
  signal?: AbortSignal,
): Promise<Page<Target>> {
  // 50, not 100: both live personalities hold fewer than 100 followed, so a
  // page of 100 meant Load more never appeared and the list looked unpaged
  // right up until the first personality that would have hung the browser.
  const p = new URLSearchParams({ limit: '50' });
  if (opts.q) p.set('q', opts.q);
  if (opts.state) p.set('state', opts.state);
  if (opts.cursor) p.set('cursor', opts.cursor);
  return req<unknown>(`/api/personalities/${id}/targets?${p}`, { signal }).then((r) =>
    asPage<Target>(r),
  );
}

export const api = {
  /** Who the cookie says we are. Drives whether the login screen shows. */
  session: () => req<Session>('/api/session'),

  login: (username: string, password: string) =>
    req<Session>('/api/session', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => req<Session>('/api/session', { method: 'DELETE' }),

  /** The vocabulary travels with the value: the UI never hardcodes an origin
   *  list that could drift out of step with what the extractor returns. The
   *  server now builds it from this client's own people, so `origins` is the
   *  one part of the payload worth coercing -- `rule` is passed through
   *  untouched so a server that omits it still trips the screen's own guard
   *  rather than rendering an empty rule as a real one. */
  rules: () =>
    req<unknown>('/api/rules').then((r) => {
      const raw = fields(r);
      return { options: asRuleOptions(raw.options), rule: raw.rule as Rule };
    }),

  saveRules: (rule: Rule) =>
    req<{ saved: boolean; rule: Rule; note?: string }>('/api/rules', {
      method: 'PUT',
      body: JSON.stringify(rule),
    }),

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

  /** The operator saying an account is further along than the ladder thinks:
   *  'seeding' for one they wiped by hand, 'established' for one that is
   *  already onboarded and should go straight to the Quick Add walk. Answers
   *  with the whole account row, so the caller can replace it without a
   *  refetch. Cleanup rungs are refused by the server -- there is deliberately
   *  no way to send an account BACK into a wipe from here. */
  markOnboarded: (accountId: string, to: 'seeding' | 'established') =>
    req<Account>(`/api/accounts/${accountId}/onboarded`, {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),

  addAccount: (id: string, label: string) =>
    req<Account>(`/api/personalities/${id}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),

  /** Pause and resume. The cap is a client setting -- see settings/saveSettings. */
  updateAccount: (id: string, patch: { enabled?: boolean }) =>
    req<Account>(`/api/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /**
   * Frees today's handouts on one account so the same test can be run again the
   * same day. POST and not a PATCH field: it is a command, and a settable
   * "reset" field would be one that always reads back false. No body — the
   * server whitelists request bodies and would reject one.
   */
  resetDailyCap: (id: string) =>
    req<CapReset>(`/api/accounts/${id}/reset-daily-cap`, { method: 'POST' }),

  /**
   * Delete an account and everything hanging off it.
   *
   * Irreversible, and wider than it looks: assignments, hides and sheets all
   * cascade. The PEOPLE survive -- they belong to the personality -- and losing
   * their assignments is what frees them to be handed to a sibling account,
   * which is usually the point.
   *
   * Answers with what it destroyed rather than 204, so the screen can say how
   * much it was after the fact.
   */
  deleteAccount: (id: string) =>
    req<AccountRemoved>(`/api/accounts/${id}`, { method: 'DELETE' }),

  settings: () => req<SettingsRead>('/api/settings'),

  /** Partial, and the screen relies on it: a field left blank is omitted rather
   *  than sent as 0, so clearing one box cannot silently stop every account. The
   *  server writes only the keys that arrive. */
  saveSettings: (patch: Partial<Settings>) =>
    req<Settings & { saved: boolean }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  targets: (
    id: string,
    opts: { q?: string; state?: string; cursor?: string } = {},
    signal?: AbortSignal,
  ) => targetPage(id, opts, signal),

  /** The state is set here rather than passed in: the Followed screen is only
   *  ever that one state, and a caller able to change it would make the export
   *  link beside the table lie about what it is exporting. */
  followed: (id: string, opts: { q?: string; cursor?: string } = {}, signal?: AbortSignal) =>
    targetPage(id, { ...opts, state: 'followed' }, signal),

  /**
   * A URL, not a request. The button is a plain navigation to a route that
   * streams, so the browser writes the file as it arrives and holds nothing;
   * building the same CSV here would mean paging tens of thousands of rows into
   * memory first, and a page that failed at request 73 would save a short file
   * that looks complete. The session cookie rides along with the navigation,
   * which is why no token goes in the query string.
   */
  /** One handle per line, which is what the Import screen takes. `conf` narrows
   *  it to the confidences the extractor gave the nationality it read -- an
   *  export of `high` alone is the list worth carrying to another system. */
  followedTxtUrl: (id: string, opts: { q?: string; conf?: string[] } = {}) => {
    const p = new URLSearchParams({ state: 'followed' });
    if (opts.q) p.set('q', opts.q);
    if (opts.conf?.length) p.set('conf', opts.conf.join(','));
    return `/api/personalities/${id}/targets.txt?${p}`;
  },

  proxies: () => req<ProxyPool>('/api/proxies'),

  importProxies: (text: string) =>
    req<ImportResult>('/api/proxies', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /** Answers with how many accounts it left unassigned, so the screen can say
   *  so instead of the operator discovering it row by row. */
  deleteProxy: (id: string) =>
    req<{ deleted: boolean; unassigned: number }>(`/api/proxies/${id}`, {
      method: 'DELETE',
    }),

  stock: () => req<StockPool>('/api/stock-accounts'),

  /** Every row this adds is put behind a proxy in the same call — random among
   *  the least loaded, so the spread stays even without anyone doing sums. */
  importStock: (text: string) =>
    req<StockImportResult>('/api/stock-accounts', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /** Assign or re-roll one account's proxy, drawn exactly as the import draws. */
  assignStock: (id: string) =>
    req<StockAccount>(`/api/stock-accounts/${id}/assign`, { method: 'POST' }),

  /** The repair button: deal proxies to every account that has none — for when
   *  proxies arrived later than the accounts did, or one was deleted. */
  assignUnassignedStock: () =>
    req<{ assigned: number; unassigned: number }>('/api/stock-accounts/assign-unassigned', {
      method: 'POST',
    }),

  setStockDeployed: (id: string, deployed: boolean) =>
    req<StockAccount>(`/api/stock-accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ deployed }),
    }),

  deleteStock: (id: string) =>
    req<{ deleted: boolean }>(`/api/stock-accounts/${id}`, { method: 'DELETE' }),

  onboardingPool: () => req<OnboardingPool>('/api/onboarding'),

  importHandles: (text: string) =>
    req<ImportResult>('/api/onboarding', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  clearOnboarding: (which: 'used' | 'all') =>
    req<{ deleted: number }>('/api/onboarding', {
      method: 'DELETE',
      body: JSON.stringify({ which }),
    }),

  /** Drop one handle from the pool. The two clears above are all-or-nothing and
   *  neither covers the ordinary case: one bad name in a list of hundreds.
   *  Answers with `wasUsed`, because removing a SPENT row also deletes the
   *  record that stops that handle reaching a second account. */
  deleteHandle: (id: string) =>
    req<{ deleted: boolean; handle: string; wasUsed: boolean }>(
      `/api/onboarding/${id}`,
      { method: 'DELETE' },
    ),

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
