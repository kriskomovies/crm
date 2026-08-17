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
