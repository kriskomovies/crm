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
      countries: ['English'],
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
