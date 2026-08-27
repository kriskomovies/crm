import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type ImportedHandle, type ImportResult, type OnboardingPool } from './api';
import { count, when } from './ui';

/**
 * The list a brand-new account is seeded from.
 *
 * A fresh Snapchat account is shown no suggestions at all, so there is no roster
 * to walk and nothing to hand it. It is onboarded by searching people by name
 * instead, and that needs a list of names. Around fifty is enough — after that
 * Snapchat starts suggesting people of its own and the ordinary walk takes over.
 *
 * The Followed screen exports in exactly this format, so a list acquired by one
 * system pastes straight into the next.
 */
export function Import() {
  const [pool, setPool] = useState<OnboardingPool | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Row removals each reload the whole pool, and two fired close together can
  // return out of order -- the slower response, read before the other's delete
  // committed, would put a removed handle back on screen. Every load takes a
  // ticket; only the newest writes. The same guard the overview poll uses.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const p = await api.onboardingPool();
      if (mine !== seq.current) return;
      setPool(p);
      setErr(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (body: string) => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.importHandles(body));
      setText('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Reading the file here rather than posting it means the operator sees what is
  // about to be sent, and a file picked by mistake costs nothing.
  const pick = (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    file
      .text()
      .then((t) => setText(t))
      .catch((e) => setErr(String(e)));
  };

  const clear = async (which: 'used' | 'all') => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.clearOnboarding(which);
      setResult(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Import handles</h2>
            <p className="muted small">
              One handle per line. A new account has no Quick Add suggestions, so it is
              seeded by searching these by name — about fifty is enough before Snapchat
              starts suggesting people on its own.
            </p>
          </div>
          {pool && (
            <div className="panel-actions">
              <span className="pill pill-queued">{count(pool.available)} available</span>
              <span className="pill pill-followed">{count(pool.used)} used</span>
            </div>
          )}
        </header>

        <div className="inset">
          <textarea
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'kris_snap_04\nmia.rosee\nvinnie.g'}
          />
          <div className="row-form">
            <button className="primary" onClick={() => void send(text)} disabled={busy || !text.trim()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
            <label className="button">
              Choose a .txt
              <input
                type="file"
                accept=".txt,text/plain"
                style={{ display: 'none' }}
                onChange={(e) => pick(e.target.files?.[0])}
              />
            </label>
            {err && <span className="error">{err}</span>}
          </div>
        </div>

        {result && (
          <div className="inset">
            <p className="small">
              <strong>{count(result.added)}</strong> added ·{' '}
              <strong>{count(result.duplicate)}</strong> already in the list ·{' '}
              <strong>{result.invalid.length}</strong> not handles ·{' '}
              <strong>{count(result.total)}</strong> in the pool
            </p>
            {result.invalid.length > 0 && (
              <p className="bad small">
                Not imported: {result.invalid.join(', ')}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>The pool</h2>
            <p className="muted small">
              A used handle is kept rather than deleted, so no two accounts of this client
              are ever handed the same person. Removing one — here or with Clear used —
              makes that person eligible again.
            </p>
          </div>
          <div className="panel-actions">
            <button onClick={() => void clear('used')} disabled={busy}>
              Clear used
            </button>
            <button className="danger" onClick={() => void clear('all')} disabled={busy}>
              Clear all
            </button>
          </div>
        </header>

        {!pool || pool.items.length === 0 ? (
          <p className="muted small inset">Nothing imported yet.</p>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>handle</th>
                  <th>used by</th>
                  <th>used at</th>
                  <th>imported</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pool.items.map((h) => (
                  <HandleRow key={h.id} h={h} onChanged={() => void load()} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/**
 * One handle, with the remove the two bulk clears above cannot express.
 *
 * Emptying the whole pool to drop a single bad name — one that no longer
 * exists, one pasted by mistake, one that keeps failing the search — and then
 * re-importing the file was the only thing possible before this.
 *
 * A spent handle asks first. Its row is not a leftover: it is the record that
 * stops that person being handed to a second account of this client, so
 * deleting it is the same consequence "Clear used" carries, for one person.
 * An unused handle is just a name in a queue and goes without ceremony.
 */
function HandleRow({ h, onChanged }: { h: ImportedHandle; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteHandle(h.id);
      // No success state to show: the row it would have rendered in is gone.
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <tr className={h.usedAt ? 'off' : ''}>
        <td data-label="handle">
          <code>@{h.handle}</code>
        </td>
        <td data-label="used by">
          {h.account ? <code>{h.account}</code> : <span className="muted">—</span>}
        </td>
        <td data-label="used at" className="muted small">
          {when(h.usedAt)}
        </td>
        <td data-label="imported" className="muted small">
          {when(h.createdAt)}
        </td>
        <td data-label="" className="actions">
          {err && <span className="error small">{err}</span>}
          <button
            className="link danger"
            disabled={busy}
            onClick={() => {
              setErr(null);
              // An unused handle is a name in a queue; asking about it would be
              // ceremony for nothing. A spent one gets the sentence below.
              if (h.usedAt) setConfirm((v) => !v);
              else void remove();
            }}
          >
            {confirm ? 'keep it' : 'remove'}
          </button>
        </td>
      </tr>

      {confirm && (
        <tr>
          {/* Five columns: handle, used by, used at, imported, actions. */}
          <td className="rowdetail" data-label="" colSpan={5}>
            <p className="rowdetail-p">
              Remove <code>@{h.handle}</code>? It has already been spent
              {h.account ? (
                <>
                  {' '}
                  by <code>{h.account}</code>
                </>
              ) : null}
              , and this row is what stops it being handed to a second account of this
              client. Removing it makes that person <strong>eligible again</strong> — the
              same consequence Clear used carries, for this one handle. Nothing changes on
              Snapchat: anyone already added stays added.
            </p>
            <div className="rowdetail-actions">
              <button className="danger" disabled={busy} onClick={() => void remove()}>
                {busy ? 'Removing…' : `Remove @${h.handle}`}
              </button>
              <button disabled={busy} onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
