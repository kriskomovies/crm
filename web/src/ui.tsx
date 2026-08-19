/** Small shared pieces. Kept here so the screens stay about their own logic. */

import { num } from './api';

export function Pill({ value }: { value: string | null }) {
  if (!value) return <span className="pill pill-none">unassigned</span>;
  return <span className={`pill pill-${value}`}>{value.replace('_', ' ')}</span>;
}

/**
 * Daily cap as a bar rather than "13/25".
 *
 * It turns red at the cap because a spent budget is the difference between an
 * account that is idle and one that is being throttled by the platform, and an
 * operator scanning ten accounts should not have to do the arithmetic.
 *
 * `landed` is optional and draws a second fill inside the first. Without it this
 * bar cannot show a run in progress AT ALL: `used` counts cap slots taken, so it
 * jumps by a whole batch the moment an agent claims and then holds perfectly
 * still for however long that batch takes to work through -- which is the exact
 * window an operator is watching, and reads as a frozen page. The green segment
 * is follows that actually landed, so it advances by one on every add. It is
 * always the shorter of the two: a follow spends a slot, so it cannot outrun the
 * claim that gave it one.
 */
export function CapBar({ used, cap, landed }: { used: number; cap: number; landed?: number }) {
  const u = num(used);
  const c = num(cap);
  // A cap of 0 hands out nothing, so any use at all is already over budget --
  // and dividing by it would put NaN into the width and collapse the bar.
  const full = u > 0 && u >= c;
  const pct = c > 0 ? Math.min(100, (u / c) * 100) : full ? 100 : 0;
  const done = landed === undefined ? null : num(landed);
  const donePct = done !== null && c > 0 ? Math.min(100, (done / c) * 100) : 0;
  return (
    <div className="cap">
      <div className="cap-track">
        <div
          className="cap-fill"
          style={{ width: `${pct}%`, background: full ? 'var(--red)' : 'var(--accent)' }}
        />
        {done !== null && (
          <div className="cap-lead" style={{ width: `${donePct}%` }} title={`${done} followed today`} />
        )}
      </div>
      <span className="cap-label">
        {u}/{c}
        {done !== null && <em className="cap-done"> {done} ✓</em>}
      </span>
    </div>
  );
}

/**
 * Whether this account needs looking at, from the counts already on its row.
 *
 * The operator's dominant anxiety is account death, and until now the only
 * signal for it was a `failed today` integer sitting among five other integers.
 * A machine whose adds are being refused looks exactly like one having a quiet
 * morning: both show small numbers.
 *
 * The rule is deliberately arithmetic and client-side, so it cannot disagree
 * with the numbers printed beside it:
 *
 *   paused        the operator turned it off; nothing is wrong with it
 *   blocked       it has failed repeatedly today and landed NOTHING. That is
 *                 what Snapchat refusing adds looks like from here.
 *   needs a check failures are a real share of what it attempted today
 *   healthy       everything else
 *
 * "Today" is the only scope available: a reported failure goes back to the queue
 * and is offered again another day, so there is no terminal failed row to count.
 */
export type Health = { state: 'healthy' | 'needs a check' | 'blocked' | 'paused'; why: string };

export function health(a: {
  enabled: boolean;
  failedToday: number;
  followedToday: number;
}): Health {
  const failed = num(a.failedToday);
  const landed = num(a.followedToday);
  if (!a.enabled) return { state: 'paused', why: 'paused by the operator' };
  if (failed === 0) return { state: 'healthy', why: 'nothing has failed today' };
  if (failed >= 3 && landed === 0) {
    return {
      state: 'blocked',
      why: `${failed} attempts today and not one landed — Snapchat may be refusing adds`,
    };
  }
  const attempted = failed + landed;
  if (failed >= 3 || (attempted > 0 && failed / attempted >= 0.25)) {
    return { state: 'needs a check', why: `${failed} of ${attempted} attempts failed today` };
  }
  return { state: 'healthy', why: `${failed} of ${attempted} attempts failed today` };
}

/** The same thing as a pill. Its own class rather than Pill's, because a state
 *  the server reported and a verdict this file worked out are different kinds
 *  of thing and should not be able to drift into the same stylesheet rule. */
export function HealthPill({ a }: { a: Parameters<typeof health>[0] }) {
  const h = health(a);
  return (
    <span className={`pill health-${h.state.replace(/ /g, '-')}`} title={h.why}>
      {h.state}
    </span>
  );
}

/** Thousands separators, because six-figure profile counts are unreadable raw. */
export const count = (v: unknown): string => num(v).toLocaleString();

export const money = (v: unknown, dp = 2): string => `$${num(v).toFixed(dp)}`;

/** A rate with no attempts behind it is unknown, not 0%. */
export const rate = (hit: number, of: number): string =>
  of > 0 ? `${Math.round((hit / of) * 100)}%` : '—';

/** A sheet still extracting has no timestamp yet; "Invalid Date" is not a status. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
