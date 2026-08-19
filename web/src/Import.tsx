import { useCallback, useEffect, useState } from 'react';

import { api, type ImportResult, type OnboardingPool } from './api';
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

  const load = useCallback(async () => {
    try {
      setPool(await api.onboardingPool());
      setErr(null);
    } catch (e) {
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
              are ever handed the same person.
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
                </tr>
              </thead>
              <tbody>
                {pool.items.map((h) => (
                  <tr key={h.id} className={h.usedAt ? 'off' : ''}>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
