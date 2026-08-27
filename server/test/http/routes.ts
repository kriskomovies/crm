/**
 * The route table, written out by hand, and the reason it is written out.
 *
 * A guard is invisible in a service test: `personalities.targets(clientId, ...)`
 * is the test supplying the clientId, so it passes identically whether or not
 * anything checks who the caller is. The only way a missing @UseGuards shows up
 * is if something walks the whole HTTP surface and demands 401 from every entry.
 * "The whole surface" is the part that rots -- a controller added in six months
 * is exactly the one nobody adds a test for.
 *
 * So this list is checked against the routes Express actually serves, and the
 * auth matrix runs over the list. Adding a route without adding it here fails
 * the drift test; adding it here without a guard fails the auth matrix. Neither
 * can be satisfied by remembering to do something.
 *
 * KEEP IN SYNC with the controllers. That is the whole contract of this file.
 *
 * Path params are placeholder uuids on purpose. The auth matrix must be able to
 * fire every verb -- including DELETE /api/personalities/:id -- without touching
 * a real row, and a 404 is a perfectly good "not 401".
 */
import { NO_NATIONALITY } from '../../src/extraction/normalize';

/** Not a real id anywhere, so a request that gets past the guard finds nothing. */
export const ABSENT = '00000000-0000-4000-8000-0000000000ff';

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** As Express registers it, so the drift test can compare strings. */
  path: string;
  /** The same route with the params filled in. */
  sample: string;
  /** Sent when the request needs a body to be interesting. Guards run before
   *  pipes in Nest, so an absent or invalid body still has to 401. */
  body?: unknown;
}

export const ROUTES: RouteSpec[] = [
  // SheetsController
  {
    method: 'POST',
    path: '/v1/accounts/:accountId/sheets',
    sample: `/v1/accounts/${ABSENT}/sheets`,
  },
  {
    method: 'GET',
    path: '/v1/accounts/:accountId/sheets/:jobId',
    sample: `/v1/accounts/${ABSENT}/sheets/${ABSENT}`,
  },

  // TargetsController -- the metered claim and its callback
  {
    method: 'GET',
    path: '/v1/accounts/:accountId/targets',
    sample: `/v1/accounts/${ABSENT}/targets`,
  },
  {
    method: 'POST',
    path: '/v1/accounts/:accountId/targets/:handle/result',
    sample: `/v1/accounts/${ABSENT}/targets/someone/result`,
    body: { result: 'followed' },
  },
  // The roster call: one question about the people on screen, in place of the
  // two about the ledger it replaced. A metered WRITE -- an `add` is charged to
  // today's cap in the transaction that decided it -- so it is guarded exactly
  // as the claim is.
  {
    method: 'POST',
    path: '/v1/accounts/:accountId/targets/roster',
    sample: `/v1/accounts/${ABSENT}/targets/roster`,
  },
  // A person the machine swiped off its Quick Add roster. Guarded for the
  // ordinary reason and one sharper one: hiding cannot be undone, so an
  // unguarded route here lets a stranger permanently remove people from another
  // tenant's roster.
  {
    method: 'POST',
    path: '/v1/accounts/:accountId/targets/:handle/hidden',
    sample: `/v1/accounts/${ABSENT}/targets/someone/hidden`,
  },

  // PersonalityLedgerController
  {
    method: 'GET',
    path: '/v1/personalities/:personalityId/ledger',
    sample: `/v1/personalities/${ABSENT}/ledger`,
  },
  // A machine creating its own account from the handle on its emulator's
  // screen. Guarded like every other /v1 route -- it is the operator's
  // POST /api/personalities/:id/accounts that it must not be confused with.
  {
    method: 'POST',
    path: '/v1/personalities/:personalityId/accounts',
    sample: `/v1/personalities/${ABSENT}/accounts`,
    body: { handle: 'authmatrix' },
  },

  // PersonalitiesController
  { method: 'GET', path: '/api/personalities', sample: '/api/personalities' },
  {
    method: 'POST',
    path: '/api/personalities',
    sample: '/api/personalities',
    body: { name: 'auth-matrix' },
  },
  {
    method: 'POST',
    path: '/api/personalities/:id/accounts',
    sample: `/api/personalities/${ABSENT}/accounts`,
    body: { label: 'auth-matrix' },
  },
  {
    method: 'GET',
    path: '/api/personalities/:id/targets',
    sample: `/api/personalities/${ABSENT}/targets`,
  },
  // The ledger as a file. Guarded like its JSON twin, and it has to be: it is
  // the whole ledger in one response rather than a page of it.
  //
  // .txt, not .csv. The CSV export was replaced by one handle per line -- eight
  // columns is the right shape for a spreadsheet and the wrong one for feeding
  // handles back into a machine, which is what this export is for. The route
  // was swapped and this table was not, so the drift test had been failing ever
  // since and the auth matrix was firing four times at a path Express no longer
  // served.
  {
    method: 'GET',
    path: '/api/personalities/:id/targets.txt',
    sample: `/api/personalities/${ABSENT}/targets.txt`,
  },
  {
    method: 'POST',
    path: '/api/personalities/:id/targets',
    sample: `/api/personalities/${ABSENT}/targets`,
    body: { handles: ['auth_matrix'] },
  },
  {
    method: 'DELETE',
    path: '/api/personalities/:id',
    sample: `/api/personalities/${ABSENT}`,
  },

  // AccountsController
  {
    method: 'PATCH',
    path: '/api/accounts/:id',
    sample: `/api/accounts/${ABSENT}`,
    body: { dailyCap: 10 },
  },
  // Gives one account today's cap back so the same test can be run twice in a
  // day. Guarded like everything else here -- it rewrites another tenant's
  // ledger if it is not.
  // Removing an account from the screen it appears on. Guarded, and it has to
  // be: unguarded it deletes another tenant's account and cascades its ledger.
  // It shipped without being declared here, so the drift check was failing and
  // the auth matrix was firing at it zero times.
  {
    method: 'DELETE',
    path: '/api/accounts/:id',
    sample: `/api/accounts/${ABSENT}`,
  },
  {
    method: 'POST',
    path: '/api/accounts/:id/reset-daily-cap',
    sample: `/api/accounts/${ABSENT}/reset-daily-cap`,
  },

  // OnboardingController -- the pool of handles a brand-new account is seeded
  // from. A new Snapchat account is shown no Quick Add suggestions at all, so
  // it is onboarded by searching names instead, and this is where those names
  // are kept. Guarded: the pool is per client and naming who a tenant is about
  // to approach is worth as much as the ledger itself.
  { method: 'GET', path: '/api/onboarding', sample: '/api/onboarding' },
  {
    method: 'POST',
    path: '/api/onboarding',
    sample: '/api/onboarding',
  },
  { method: 'DELETE', path: '/api/onboarding', sample: '/api/onboarding' },
  // One handle, which the two clears above cannot express: a single bad name in
  // a list of hundreds. Guarded like the rest -- and scoped by clientId in the
  // WHERE, so another tenant's id matches nothing rather than 404ing after a
  // read that confirmed the row exists.
  {
    method: 'DELETE',
    path: '/api/onboarding/:id',
    sample: '/api/onboarding/00000000-0000-0000-0000-000000000000',
  },

  // ProxiesController and StockAccountsController -- the proxies and the
  // not-yet-assigned Snapchat logins this client owns. Both guarded, and both
  // shipped undeclared: the drift check caught them, which is what it is for.
  // The stock rows carry account credentials, so an unguarded read here would
  // hand another tenant's logins to anyone who asked.
  { method: 'GET', path: '/api/proxies', sample: '/api/proxies' },
  { method: 'POST', path: '/api/proxies', sample: '/api/proxies' },
  {
    method: 'DELETE',
    path: '/api/proxies/:id',
    sample: `/api/proxies/${ABSENT}`,
  },
  { method: 'GET', path: '/api/stock-accounts', sample: '/api/stock-accounts' },
  { method: 'POST', path: '/api/stock-accounts', sample: '/api/stock-accounts' },
  {
    method: 'POST',
    path: '/api/stock-accounts/assign-unassigned',
    sample: '/api/stock-accounts/assign-unassigned',
  },
  {
    method: 'POST',
    path: '/api/stock-accounts/:id/assign',
    sample: `/api/stock-accounts/${ABSENT}/assign`,
  },
  {
    method: 'PATCH',
    path: '/api/stock-accounts/:id',
    sample: `/api/stock-accounts/${ABSENT}`,
  },
  {
    method: 'DELETE',
    path: '/api/stock-accounts/:id',
    sample: `/api/stock-accounts/${ABSENT}`,
  },

  // SettingsController -- how hard to push every account, one setting per client
  { method: 'GET', path: '/api/settings', sample: '/api/settings' },
  {
    method: 'PUT',
    path: '/api/settings',
    sample: '/api/settings',
    // Every field the DTO declares. forbidNonWhitelisted means a body that
    // omits one is not exercising the route a screen actually sends to.
    body: {
      dailyCapPerAccount: 240,
      sessionCapPerAccount: 80,
      sessionWindowMinutes: 60,
      followPaceSeconds: 2,
      // A member of EXTRACTION_MODELS, not a placeholder: @IsIn refuses
      // anything else, and a body the DTO rejects would make the auth matrix
      // pass on a 400 that never reached the guard's route.
      extractionModel: 'gemini-3.6-flash',
    },
  },

  // StatsController
  { method: 'GET', path: '/api/stats', sample: '/api/stats' },

  // CrmController
  { method: 'GET', path: '/api/overview', sample: '/api/overview' },
  { method: 'GET', path: '/api/sheets', sample: '/api/sheets' },
  {
    method: 'GET',
    path: '/api/sheets/:id/image',
    sample: `/api/sheets/${ABSENT}/image`,
  },

  // RulesController -- the targeting filter the Targeting page edits
  { method: 'GET', path: '/api/rules', sample: '/api/rules' },
  {
    method: 'PUT',
    path: '/api/rules',
    sample: '/api/rules',
    body: {
      presentsAs: ['man'],
      // The sentinel, not a country name, and for the same reason the settings
      // body above pins a real EXTRACTION_MODELS member: countries are now
      // validated against what THIS client's extractor has actually returned,
      // so any real nationality would 400 for a client whose ledger is empty --
      // and the auth matrix would then pass on a 400 that never reached the
      // guard's route. The sentinel is the one value always in the option list,
      // because the null bucket exists whether or not anyone is in it.
      countries: [NO_NATIONALITY],
      skinTones: ['light', 'light-tan'],
      minConfidence: 'low',
    },
  },

  // EnrolmentController -- the operator's side of machine enrolment
  { method: 'GET', path: '/api/enrolment', sample: '/api/enrolment' },
  {
    method: 'POST',
    path: '/api/enrolment/open',
    sample: '/api/enrolment/open',
    body: { minutes: 10 },
  },
  { method: 'POST', path: '/api/enrolment/close', sample: '/api/enrolment/close' },
  // Mints the bootstrap secret a machine presents to /v1/enrol. Guarded, and it
  // has to be: anyone who can mint one can enrol a machine into this client.
  { method: 'POST', path: '/api/enrolment/token', sample: '/api/enrolment/token' },
  {
    method: 'DELETE',
    path: '/api/enrolment/machines/:id',
    sample: `/api/enrolment/machines/${ABSENT}`,
  },
];

/**
 * Routes that are UNAUTHENTICATED on purpose.
 *
 * Listed rather than omitted. Leaving one out of ROUTES would also satisfy the
 * drift test -- silently, and with no record that anyone decided it -- which is
 * exactly the state /api/* was in when it was serving every tenant's ledger to
 * anyone who asked. An entry here is a claim someone has to justify in review.
 *
 * Each one needs its own test proving the thing that limits it, since the auth
 * matrix cannot: see enrolment.http.spec.ts.
 */
export const UNGUARDED: RouteSpec[] = [
  // The operator login. Unguarded of necessity -- it is how a browser with no
  // session gets one -- and constrained instead by accepting only the single
  // configured credential. GET and DELETE are here for the same reason: asking
  // "am I signed in" and "sign me out" both have to work without being signed
  // in, and neither reveals anything a caller did not already send.
  { method: 'GET', path: '/api/session', sample: '/api/session' },
  {
    method: 'POST',
    path: '/api/session',
    sample: '/api/session',
    body: { username: 'nobody', password: 'wrong' },
  },
  { method: 'DELETE', path: '/api/session', sample: '/api/session' },
  {
    // How a machine with no credential gets one. Constrained instead by the
    // enrolment token it presents, or -- for agents built before the token
    // existed -- by the operator's window: closed by default, expires on its
    // own, and refuses outright when more than one client has it open.
    method: 'POST',
    path: '/v1/enrol',
    sample: '/v1/enrol',
    body: { name: 'auth-matrix' },
  },
];

/** "METHOD /path" for every declared route, in the shape Harness.routes() returns. */
export function declaredRoutes(): string[] {
  return [...ROUTES, ...UNGUARDED].map((r) => `${r.method} ${r.path}`).sort();
}
