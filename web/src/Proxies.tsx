import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type ImportResult, type Proxy, type ProxyPool } from './api';
import { count, proxyAddr, when } from './ui';

/**
 * The proxies WE bought for the emulator fleet. Stock, not workflow: nothing
 * the software does ever reads this list — it exists so "which proxy does
 * this emulator get" has one answer in one place, instead of a text file on
 * someone's desktop.
 *
 * Every account added on the Accounts tab is put behind one of these at
 * import, random among the least loaded, so the spread stays even on its own.
 * Adding a proxy here never reshuffles anybody — accounts already assigned
 * are already configured on their emulators — the new proxy just absorbs new
 * imports until it has caught up.
 */
export function Proxies() {
  const [pool, setPool] = useState<ProxyPool | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  // What the last delete cost, held on screen: the freed accounts are on the
  // OTHER tab, so nothing visible here would otherwise say it happened.
  const [freed, setFreed] = useState<number | null>(null);

  // Two row actions firing close together each reload the whole list, and their
  // responses can land out of order -- the slower one, read before the other's
  // write committed, would reinstate a stale snapshot (a deleted proxy back on
  // screen). Every load takes a ticket; only the newest writes. Same guard the
  // overview poll uses in App.tsx.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const p = await api.proxies();
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
      setResult(await api.importProxies(text));
      setText('');
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
            <h2>Add proxies</h2>
            <p className="muted small">
              One per line, in any of the shapes sellers export:{' '}
              <code>host:port</code> · <code>host:port:user:pass</code> ·{' '}
              <code>user:pass@host:port</code> · <code>socks5://user:pass@host:port</code>.
              Re-pasting the same file is how the list is topped up — duplicates are skipped,
              never doubled.
            </p>
          </div>
          {pool && (
            <div className="panel-actions">
              <span className="pill pill-queued">{count(pool.total)} proxies</span>
            </div>
          )}
        </header>

        <div className="inset">
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'gw.provider.io:31112:customer-a:s3cret\n1.2.3.4:8080\nsocks5://user:pass@5.6.7.8:1080'}
          />
          <div className="row-form">
            <button className="primary" onClick={() => void send()} disabled={busy || !text.trim()}>
              {busy ? 'Adding…' : 'Add proxies'}
            </button>
            {err && <span className="error">{err}</span>}
          </div>
        </div>

        {result && (
          <div className="inset">
            <p className="small">
              <strong>{count(result.added)}</strong> added ·{' '}
              <strong>{count(result.duplicate)}</strong> already in the list ·{' '}
              <strong>{result.invalid.length}</strong> not proxies ·{' '}
              <strong>{count(result.total)}</strong> in stock
            </p>
            {result.invalid.length > 0 && (
              <p className="bad small">Not added: {result.invalid.join(' · ')}</p>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>The proxies</h2>
            <p className="muted small">
              Ours only — the software is never told these exist. The accounts column is what
              the even spread keeps even.
            </p>
          </div>
        </header>

        {freed !== null && (
          <p className="inset small">
            {freed === 0 ? (
              <>Deleted. No account was behind it.</>
            ) : (
              <>
                Deleted. <strong>{freed}</strong> account{freed === 1 ? '' : 's'} lost{' '}
                {freed === 1 ? 'its' : 'their'} proxy — assign them again on the Accounts tab.
              </>
            )}{' '}
            <button className="link" onClick={() => setFreed(null)}>
              dismiss
            </button>
          </p>
        )}

        {!pool || pool.items.length === 0 ? (
          <p className="muted small inset">
            No proxies yet. Accounts added before any exist stay unassigned until one is added
            and they are assigned from the Accounts tab.
          </p>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>proxy</th>
                  <th>login</th>
                  <th>password</th>
                  <th className="num" title="stock accounts currently behind it — the number the even spread keeps even">
                    accounts
                  </th>
                  <th>added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pool.items.map((p) => (
                  <ProxyRow
                    key={p.id}
                    p={p}
                    onDeleted={(n) => {
                      setFreed(n);
                      void load();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function ProxyRow({ p, onDeleted }: { p: Proxy; onDeleted: (freed: number) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const remove = async () => {
    setDeleting(true);
    setErr(null);
    try {
      const out = await api.deleteProxy(p.id);
      onDeleted(out.unassigned);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  return (
    <>
      <tr>
        <td data-label="proxy">
          <code>{proxyAddr(p)}</code>
        </td>
        <td data-label="login">{p.username ? <code>{p.username}</code> : <span className="muted">—</span>}</td>
        <td data-label="password">{p.password ? <code>{p.password}</code> : <span className="muted">—</span>}</td>
        <td data-label="accounts" className="num">
          {p.accounts || ''}
        </td>
        <td data-label="added" className="muted small">
          {when(p.createdAt)}
        </td>
        <td data-label="" className="actions">
          {err && <span className="error small">{err}</span>}
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
          {/* Six columns: proxy, login, password, accounts, added, actions. */}
          <td className="rowdetail" data-label="" colSpan={6}>
            <p className="rowdetail-p">
              Remove <code>{proxyAddr(p)}</code>?{' '}
              {p.accounts > 0 ? (
                <>
                  The <strong>{p.accounts}</strong> account{p.accounts === 1 ? '' : 's'} behind it{' '}
                  {p.accounts === 1 ? 'is' : 'are'} <strong>not</strong> deleted — they lose their
                  proxy and wait on the Accounts tab to be assigned a new one. Any emulator
                  already configured with this proxy keeps its own copy; nothing changes on a
                  device.
                </>
              ) : (
                <>No account is behind it, so nothing else changes.</>
              )}
            </p>
            <div className="rowdetail-actions">
              <button className="danger" disabled={deleting} onClick={() => void remove()}>
                {deleting ? 'Removing…' : 'Remove proxy'}
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
