import { useCallback, useEffect, useRef, useState } from 'react';

import { api, isAbort, type Sheet } from './api';
import { Pill, count, money, when } from './ui';

/**
 * The extraction log: what was uploaded, what it produced, what it cost.
 *
 * Cursor paged like the target list. A client uploading a sheet per account per
 * day fills this faster than anything else in the app, and the whole log is
 * never what anyone wants to see.
 */
export function Sheets() {
  const [items, setItems] = useState<Sheet[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async (append: boolean, next?: string) => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setLoading(true);
    setErr(null);
    try {
      const page = await api.sheets({ cursor: next }, ac.signal);
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (e) {
      if (isAbort(e)) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      // Aborted means the request that replaced this one owns the flag now.
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => inflight.current?.abort();
  }, [load]);

  if (err) return <p className="error banner">{err}</p>;
  if (loaded && items.length === 0) return <p className="muted">No sheets uploaded yet.</p>;

  return (
    <>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>received</th>
              <th>account</th>
              <th>status</th>
              <th className="num">profiles read</th>
              <th className="num">new handles</th>
              <th className="num">seconds</th>
              <th className="num">cost</th>
              <th>model</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td data-label="received">{when(s.receivedAt)}</td>
                <td data-label="account">
                  <code>{s.account}</code>
                </td>
                <td data-label="status">
                  <Pill value={s.status} />
                  {s.error && <div className="error small">{s.error}</div>}
                </td>
                <td data-label="profiles" className="num">
                  {count(s.profilesFound)}
                </td>
                {/* Zero new handles on a re-upload is the ledger working, not a
                    failure -- the personality already holds everyone on the sheet. */}
                <td
                  data-label="new"
                  className="num"
                  title={
                    s.newPeople === 0
                      ? 'already held by this personality — deduped'
                      : undefined
                  }
                >
                  {s.newPeople === 0 ? <span className="muted">0</span> : count(s.newPeople)}
                </td>
                {/* A sheet that is still extracting has no timing or cost yet.
                    toFixed on the null that arrives with it took the whole
                    table down with it. */}
                <td data-label="seconds" className="num">
                  {s.seconds == null ? <span className="muted">—</span> : s.seconds.toFixed(1)}
                </td>
                <td data-label="cost" className="num">
                  {money(s.usd, 4)}
                </td>
                <td data-label="model" className="muted">
                  {s.model ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cursor && (
        <button className="more" onClick={() => void load(true, cursor)} disabled={loading}>
          {loading ? 'loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}
