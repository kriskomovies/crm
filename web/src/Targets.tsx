import { useCallback, useEffect, useRef, useState } from 'react';

import {
  api,
  isAbort,
  parseHandles,
  type AttachResult,
  type Personality,
  type Target,
} from './api';
import { Pill } from './ui';

const STATES = ['', 'queued', 'handed_out', 'followed', 'failed', 'skipped'];

/**
 * The handles one personality holds.
 *
 * Paginated by cursor rather than page number, because a personality running
 * for a month holds tens of thousands of rows and OFFSET makes the database
 * walk and discard everything before the page it wants.
 */
export function Targets({ p, onBack }: { p: Personality; onBack: () => void }) {
  const [items, setItems] = useState<Target[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (append: boolean, next?: string) => {
      // Typing in the search box outruns the network. Without this the reply to
      // "jo" can land after the reply to "john" and put the wider result set
      // back on screen under the narrower query.
      inflight.current?.abort();
      const ac = new AbortController();
      inflight.current = ac;
      setLoading(true);
      setErr(null);
      try {
        const page = await api.targets(p.id, { q, state, cursor: next }, ac.signal);
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
    [p.id, q, state],
  );

  // Debounced on the filters. Deliberately NOT on a timer: this list is long
  // and paged, and re-fetching it every few seconds would throw away whatever
  // the operator has scrolled or loaded.
  useEffect(() => {
    // A cursor belongs to the filters that produced it. Kept across a filter
    // change, Load more would splice a page of the old query onto the new one.
    setCursor(null);
    const t = setTimeout(() => void load(false), 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => () => inflight.current?.abort(), []);

  return (
    <>
      <div className="crumb">
        <button className="link" onClick={onBack}>
          ← personalities
        </button>
        <h2>{p.name}</h2>
        <span className="muted small">{p.people} handles</span>
      </div>

      <Attach personalityId={p.id} onDone={() => void load(false)} />

      <div className="toolbar">
        <input
          placeholder="search handle or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={state} onChange={(e) => setState(e.target.value)}>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'any state' : s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <span className="muted small">{items.length} shown</span>
      </div>

      {err && <p className="error">{err}</p>}

      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>handle</th>
              <th>display name</th>
              <th>origin</th>
              <th>source</th>
              <th>state</th>
              <th>account</th>
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
                <td data-label="source">
                  <span className={`src src-${t.source}`}>{t.source}</span>
                </td>
                <td data-label="state">
                  <Pill value={t.state} />
                </td>
                <td data-label="account">
                  {t.account ? <code>{t.account}</code> : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Only after a reply has actually come back: before that the list is
          empty because nothing has been asked for yet, not because nothing matches. */}
      {loaded && items.length === 0 && !loading && <p className="muted">Nothing matches.</p>}

      {cursor && (
        <button className="more" onClick={() => void load(true, cursor)} disabled={loading}>
          {loading ? 'loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}

function Attach({
  personalityId,
  onDone,
}: {
  personalityId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<AttachResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handles = parseHandles(text);

  const submit = async () => {
    if (handles.length === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.attach(personalityId, handles));
      setText('');
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h3>Attach handles</h3>
          <p className="muted small">
            Uniqueness is per personality — another personality may hold the same
            handle, so “already attached” here means <em>this</em> personality has
            it.
          </p>
        </div>
        <button onClick={() => setOpen((v) => !v)}>{open ? 'Close' : 'Open'}</button>
      </header>

      {open && (
        <div className="inset">
          <textarea
            rows={4}
            placeholder="one per line, or comma separated — @ optional"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row-form">
            <button className="primary" onClick={submit} disabled={busy || !handles.length}>
              Attach {handles.length || ''}
            </button>
            {err && <span className="error">{err}</span>}
          </div>

          {result && (
            <div className="result">
              <span className="ok">{result.added.length} added</span>
              <span className="muted">{result.duplicate.length} already attached</span>
              <span className="muted">{result.queued} queued to an account</span>
              {result.invalid.length > 0 && (
                <div className="bad">
                  {/* Listed back rather than swallowed: a client sending 500
                      handles needs to know which ones were noise. */}
                  {result.invalid.length} rejected as not valid handles:{' '}
                  <code>{result.invalid.join(', ')}</code>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
