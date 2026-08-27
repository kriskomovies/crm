import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type StockAccount, type StockImportResult, type StockPool } from './api';
import { count, proxyAddr, when } from './ui';

/**
 * The Snapchat accounts WE hold in stock, waiting to be installed on an
 * emulator. Not the accounts on the Personalities screen — those are the
 * software's, handed targets and metered by the caps. A row here is a
 * credential pair and nothing more; no machine is ever told it exists.
 *
 * Every account is put behind a proxy the moment it is added — random among
 * the proxies with the fewest accounts, so the load ends even without anyone
 * doing arithmetic. The row shows the pair to type into the emulator: the
 * login, and the proxy to configure it behind.
 */
export function Accounts() {
  const [pool, setPool] = useState<StockPool | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<StockImportResult | null>(null);
  const [assignErr, setAssignErr] = useState<string | null>(null);

  // Row actions each reload the whole list, and two firing close together can
  // return out of order -- the slower response, read before the other's write
  // committed, would reinstate a stale snapshot (a row back "in stock" that was
  // just marked on an emulator). Every load takes a ticket; only the newest one
  // writes. Same guard the overview poll uses in App.tsx.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const p = await api.stock();
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

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.importStock(text));
      setText('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const assignAll = async () => {
    if (busy) return;
    setBusy(true);
    setAssignErr(null);
    try {
      const out = await api.assignUnassignedStock();
      if (out.unassigned > 0) {
        // The one way this happens is that there is nothing to deal from.
        setAssignErr(
          `${out.unassigned} still unassigned — there are no proxies yet. Add some on the Proxies tab first.`,
        );
      }
      await load();
    } catch (e) {
      setAssignErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unassigned = pool ? pool.total - pool.assigned : 0;

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Add accounts</h2>
            <p className="muted small">
              One per line: <code>username:password</code> (or separated by a space). Each new
              account is put behind a proxy as it lands — random among the least loaded, so the
              spread stays even. Re-pasting a file never doubles the list.
            </p>
          </div>
          {pool && (
            <div className="panel-actions">
              <span className="pill pill-queued">{count(pool.total)} in stock</span>
              {unassigned > 0 && (
                <span className="pill pill-failed">{count(unassigned)} without a proxy</span>
              )}
              <span className="pill pill-followed">{count(pool.deployed)} on emulators</span>
            </div>
          )}
        </header>

        <div className="inset">
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'kris_fresh_01:Str0ngPass\nkris_fresh_02:0therPass'}
          />
          <div className="row-form">
            <button className="primary" onClick={() => void send()} disabled={busy || !text.trim()}>
              {busy ? 'Adding…' : 'Add accounts'}
            </button>
            {err && <span className="error">{err}</span>}
          </div>
        </div>

        {result && (
          <div className="inset">
            <p className="small">
              <strong>{count(result.added)}</strong> added ·{' '}
              <strong>{count(result.duplicate)}</strong> already in the list ·{' '}
              <strong>{result.invalid.length}</strong> not readable ·{' '}
              <strong>{count(result.assigned)}</strong> put behind a proxy ·{' '}
              <strong>{count(result.total)}</strong> in stock
            </p>
            {result.unassigned > 0 && (
              <p className="bad small">
                {count(result.unassigned)} without a proxy — there are no proxies yet. Add some
                on the Proxies tab, then assign below.
              </p>
            )}
            {result.invalid.length > 0 && (
              <p className="bad small">Not added: {result.invalid.join(' · ')}</p>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>The accounts</h2>
            <p className="muted small">
              Ours only — nothing here is ever handed to the software. Each row is what gets
              typed into an emulator: the login, and the proxy to put it behind.
            </p>
          </div>
          {unassigned > 0 && (
            <div className="panel-actions">
              <button onClick={() => void assignAll()} disabled={busy}>
                Assign proxies to {count(unassigned)} unassigned
              </button>
            </div>
          )}
        </header>

        {assignErr && <p className="inset error small">{assignErr}</p>}

        {!pool || pool.items.length === 0 ? (
          <p className="muted small inset">Nothing in stock yet. Paste accounts above.</p>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>account</th>
                  <th>password</th>
                  <th>proxy</th>
                  <th>status</th>
                  <th>added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pool.items.map((a) => (
                  <StockRow key={a.id} a={a} onChanged={() => void load()} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function StockRow({ a, onChanged }: { a: StockAccount; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setErr(null);
    try {
      await api.deleteStock(a.id);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  return (
    <>
      <tr className={a.deployedAt ? 'off' : ''}>
        <td data-label="account">
          <code>{a.username}</code>
        </td>
        <td data-label="password">
          <code>{a.password}</code>
        </td>
        <td data-label="proxy">
          {a.proxy ? (
            <>
              <code>{proxyAddr(a.proxy)}</code>
              {a.proxy.username && (
                <div className="muted small">
                  <code>
                    {a.proxy.username}:{a.proxy.password}
                  </code>
                </div>
              )}
            </>
          ) : (
            <span className="pill pill-none">unassigned</span>
          )}
        </td>
        <td data-label="status">
          {a.deployedAt ? (
            <span className="pill pill-followed" title={`marked on an emulator ${when(a.deployedAt)}`}>
              on emulator
            </span>
          ) : (
            <span className="pill pill-queued">in stock</span>
          )}
        </td>
        <td data-label="added" className="muted small">
          {when(a.createdAt)}
        </td>
        <td data-label="" className="actions">
          {err && <span className="error small">{err}</span>}
          <button
            className="link"
            disabled={saving}
            title={
              a.proxy
                ? 're-draw this account’s proxy, counted as if it arrived now — it may honestly land where it already is'
                : 'draw a proxy for this account, random among the least loaded'
            }
            onClick={() => void run(() => api.assignStock(a.id))}
          >
            {a.proxy ? 're-roll proxy' : 'assign proxy'}
          </button>
          <button
            className="link"
            disabled={saving}
            onClick={() => void run(() => api.setStockDeployed(a.id, !a.deployedAt))}
          >
            {a.deployedAt ? 'back in stock' : 'on emulator'}
          </button>
          <button
            className="link danger"
            disabled={deleting}
            onClick={() => setConfirm((v) => !v)}
          >
            {confirm ? 'keep it' : 'remove'}
          </button>
        </td>
      </tr>

      {confirm && (
        <tr>
          {/* Six columns: account, password, proxy, status, added, actions. */}
          <td className="rowdetail" data-label="" colSpan={6}>
            <p className="rowdetail-p">
              Remove <code>{a.username}</code> from the stock list? The credential itself is not
              touched — the Snapchat account keeps existing
              {a.deployedAt ? ', and the emulator it is on keeps running it' : ''}; this only
              forgets that we hold it. It <strong>cannot be undone</strong> here: the password
              goes with the row.
            </p>
            <div className="rowdetail-actions">
              <button className="danger" disabled={deleting} onClick={() => void remove()}>
                {deleting ? 'Removing…' : `Remove ${a.username}`}
              </button>
              <button disabled={deleting} onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
