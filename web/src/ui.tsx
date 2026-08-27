/** Small shared pieces. Kept here so the screens stay about their own logic. */

import { num } from './api';

export function Pill({ value }: { value: string | null }) {
  if (!value) return <span className="pill pill-none">unassigned</span>;
  return <span className={`pill pill-${value}`}>{value.replace('_', ' ')}</span>;
}

/**
 * Daily cap as a bar rather than "13/25".
 *
 * THE BAR MEASURES FOLLOWS, NOT HANDOUTS
 *
 * It used to fill with cap slots taken -- rows the server handed to a machine.
 * That is what the server meters against, but it is not what the operator is
 * counting: a slot is charged at handout, and a row the walk never reached
 * spends one without anybody being followed. An account could therefore read
 * 240/240 having added 196 people, and the bar gave no hint which 240 it meant.
 *
 * So `used` is follows that LANDED. Every step of this bar is a person actually
 * added, 240/240 means 240 adds, and the account is only full when it has done
 * the work. The slots already handed out are drawn behind it as a fainter lead,
 * because the gap between the two IS the problem worth seeing: a wide gap is
 * rows charged to the cap that nobody was ever added by.
 *
 * It turns red at the cap because a spent budget is the difference between an
 * account that is idle and one being throttled by the platform, and an operator
 * scanning ten accounts should not have to do the arithmetic.
 */
export function CapBar({ used, cap, landed }: { used: number; cap: number; landed?: number }) {
  const c = num(cap);
  // `used` is the bar; `landed` (the handouts) trails behind it. The names are
  // kept so every caller reads the same as it did -- what changed is which
  // number each one passes.
  const u = num(used);
  const behind = landed === undefined ? null : num(landed);
  // A cap of 0 hands out nothing, so any use at all is already over budget --
  // and dividing by it would put NaN into the width and collapse the bar.
  // RED MEANS "NO BUDGET LEFT", AND THAT IS A FACT ABOUT HANDOUTS.
  //
  // The cap meters slots TAKEN, not follows landed: remainingToday is
  // dailyCap - handedOutToday. Colouring on `used` therefore said the opposite
  // of the truth in both directions. haelpjle landed 261 follows against a cap
  // of 240 and went red as though it were over budget -- it was not, it took
  // exactly 240 slots and some of yesterday's handouts landed today, because
  // followedToday counts by resultAt and handedToday by handedOutAt. Meanwhile
  // haileodx had spent all 240 slots with nothing left to hand out and sat
  // green, because only 234 of them had landed.
  //
  // So the fill still measures follows -- that is the number an operator is
  // counting, and the whole reason the bar stopped measuring handouts -- and
  // the COLOUR measures the budget. A day where more lands than was handed out
  // is a good day, not an error, and it no longer looks like one.
  const spent = behind !== null ? behind >= c : u >= c;
  const full = c > 0 ? spent : u > 0;
  const pct = c > 0 ? Math.min(100, (u / c) * 100) : u > 0 ? 100 : 0;
  const behindPct = behind !== null && c > 0 ? Math.min(100, (behind / c) * 100) : 0;
  return (
    <div className="cap">
      <div className="cap-track">
        {behind !== null && (
          <div
            className="cap-lead"
            style={{ width: `${behindPct}%` }}
            title={`${behind} cap slots handed out`}
          />
        )}
        <div
          className="cap-fill"
          style={{ width: `${pct}%`, background: full ? 'var(--red)' : 'var(--green)' }}
        />
      </div>
      <span
        className="cap-label"
        title={
          behind === null
            ? `${u} followed today`
            : `${u} followed today; ${behind} of ${c} cap slots taken. ` +
              `The cap meters slots taken, so follows landing today can exceed ` +
              `it when a row handed out yesterday lands now.`
        }
      >
        {u}/{c}
        {behind !== null && behind > u && (
          <em className="cap-done" title="cap slots taken by rows nobody was added by">
            {' '}
            {behind} out
          </em>
        )}
      </span>
    </div>
  );
}

/**
 * Whether this account needs looking at, from the counts already on its row.
 *
 * The operator's dominant anxiety is account death, and the only signal for it
 * used to be a `failed today` integer sitting among five other integers. A
 * machine whose adds are being refused looked exactly like one having a quiet
 * morning: both show small numbers.
 *
 *   paused        the operator turned it off; nothing is wrong with it
 *   blocked       it has failed repeatedly today and landed NOTHING. That is
 *                 what Snapchat refusing adds looks like from here.
 *   needs a check a real SHARE of what it tried today failed
 *   healthy       everything else
 *
 * The share is the whole rule, and the first version of it was wrong: it also
 * flagged any account with three failures whatever it had followed, so haileodx
 * -- 196 followed, 11 missed, 5% -- read the same as an account that could not
 * add anybody. A count of misses is not a health signal on its own. Most of them
 * are "not reached": a row the walk never got to before the roster ran out of
 * pages, which says something about the roster and nothing about the account.
 *
 * A minimum of three failures still guards the share, so one miss out of two
 * attempts early in the day does not read as 50% and cry wolf.
 *
 * "Today" is the only scope there is: a reported failure goes back to the queue
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
  const share = attempted > 0 ? failed / attempted : 0;
  const why = `${failed} of ${attempted} attempts failed today (${Math.round(share * 100)}%)`;
  if (failed >= 3 && share >= 0.25) return { state: 'needs a check', why };
  return { state: 'healthy', why };
}

/** The same verdict as a pill. Its own class rather than Pill's, because a state
 *  the server reported and a verdict this file worked out are different kinds of
 *  thing and should not be able to drift into one stylesheet rule. */
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

/** A proxy as one typeable line: scheme://host:port. The credentials stay
 *  beside it, not inside it — an emulator's dialog asks for them separately,
 *  and a password with an @ in it would make the inline form ambiguous. */
export const proxyAddr = (p: { protocol: string; host: string; port: number }): string =>
  `${p.protocol}://${p.host}:${p.port}`;

/** A sheet still extracting has no timestamp yet; "Invalid Date" is not a status. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
