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
  const full = u > 0 && u >= c;
  const pct = c > 0 ? Math.min(100, (u / c) * 100) : full ? 100 : 0;
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
      <span className="cap-label">
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
