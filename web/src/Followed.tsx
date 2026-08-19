import { useCallback, useEffect, useRef, useState } from 'react';

import { api, isAbort, type Personality, type Target } from './api';
import { when } from './ui';

/** What the extractor writes for the nationality it read. */
const CONFIDENCES = ['high', 'medium', 'low'] as const;

/**
 * The people an account actually followed, and a way to take them out.
 *
 * Every other screen answers "is the run healthy". This one answers "what did
 * the run produce", which is the only thing here worth anything outside this
 * app -- hence the export.
 *
 * Scoped to one personality because the ledger is: a handle is unique per
 * personality, an account belongs to one, and the CSV route is the same route
 * as the list with the same client scoping behind it. The personality list is
 * handed down rather than fetched again -- App already polls it, and a second
 * copy here would drift from the one in the header.
 */
export function Followed({ personalities }: { personalities: Personality[] }) {
  const [personalityId, setPersonalityId] = useState('');
  const [q, setQ] = useState('');
  // Every confidence by default, so the button exports the whole list until
  // somebody narrows it.
  const [conf, setConf] = useState<string[]>([...CONFIDENCES]);
  const [items, setItems] = useState<Target[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const inflight = useRef<AbortController | null>(null);

  // Nothing chosen yet and a personality deleted while it was chosen land in
  // the same place: the first one. Unlike Stats there is no "all" to fall back
  // to -- the route is per personality -- so an unresolved id would leave the
  // select blank and the table empty with nothing on screen explaining why.
  const selected = personalities.some((p) => p.id === personalityId)
    ? personalityId
    : (personalities[0]?.id ?? '');

  const load = useCallback(
    async (append: boolean, next?: string) => {
      if (!selected) return;
      // Typing in the search box outruns the network: without this the reply to
      // "jo" can land after the reply to "john" and put the wider result set
      // back on screen under the narrower query.
      inflight.current?.abort();
      const ac = new AbortController();
      inflight.current = ac;
      setLoading(true);
      setErr(null);
      try {
        const page = await api.followed(selected, { q, cursor: next }, ac.signal);
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
    },
    [selected, q],
  );

  // Debounced on the filters, and deliberately not on a timer: this list is
  // long and paged, and re-fetching it every few seconds would throw away
  // whatever the operator has loaded.
  useEffect(() => {
    // A cursor belongs to the filters that produced it. Kept across a change,
    // Load more would splice a page of the old query onto the new one.
    setCursor(null);
    const t = setTimeout(() => void load(false), 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => () => inflight.current?.abort(), []);

  if (personalities.length === 0)
    return <p className="muted">No personalities yet — nothing has been followed.</p>;

  return (
    <>
      <div className="toolbar">
        <select value={selected} onChange={(e) => setPersonalityId(e.target.value)}>
          {personalities.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          placeholder="search handle or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="muted small">{items.length} shown</span>
        {/* Which confidences the export carries. Not a filter on the table:
            the table is what this personality followed, and that is not in
            question -- this is about which of them are worth handing to another
            system. `high` alone is the usual answer. */}
        <div className="seg" title="confidence to export">
          {CONFIDENCES.map((c) => (
            <button
              key={c}
              className={conf.includes(c) ? 'on' : ''}
              onClick={() =>
                setConf(conf.includes(c) ? conf.filter((x) => x !== c) : [...conf, c])
              }
            >
              {c}
            </button>
          ))}
        </div>
        {/* A plain link to a route that streams, not a fetch. Built here instead
            it would mean paging every row into memory and then copying the lot
            into a blob; worse, a run that failed on page 73 would save a short
            file that looks complete. The session cookie rides along with the
            navigation, so nothing needs a token in the URL. */}
        <a className="button" href={api.followedTxtUrl(selected, { q, conf })} download>
          Export {conf.length && conf.length < 3 ? conf.join('+') : 'all'}
        </a>
      </div>

      <p className="muted small">
        Everyone this personality has actually followed. The export is this same list under
        this same search — all of it, not only the rows loaded below — as one handle per
        line, which is the format the import takes.
      </p>

      {err && <p className="error banner">{err}</p>}

      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>handle</th>
              <th>display name</th>
              <th>origin</th>
              <th>account</th>
              <th>followed</th>
              <th>handed out</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.handle}>
                <td data-label="handle">
                  <code>@{t.handle}</code>
                </td>
                <td data-label="name">{t.displayName || <span className="muted">—</span>}</td>
                <td data-label="origin">
                  {t.nationality ?? <span className="muted">—</span>}
                  {t.nationalityConf && <span className="conf"> {t.nationalityConf}</span>}
                </td>
                <td data-label="account">
                  {t.account ? <code>{t.account}</code> : <span className="muted">—</span>}
                </td>
                {/* `followedAt`, not `resultAt`. The server has always sent the
                    first and this read the second, so the column every row on
                    this screen exists to show printed an em dash for all of
                    them. Outcome before handout: what happened matters more
                    than when it was given out. */}
                <td data-label="followed">{when(t.followedAt)}</td>
                <td data-label="handed out">{when(t.handedOutAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Only after a reply has actually come back: before that the list is
          empty because nothing has been asked for yet, not because nothing matches. */}
      {loaded && items.length === 0 && !loading && (
        <p className="muted">Nothing followed here yet.</p>
      )}

      {cursor && (
        <button className="more" onClick={() => void load(true, cursor)} disabled={loading}>
          {loading ? 'loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}
