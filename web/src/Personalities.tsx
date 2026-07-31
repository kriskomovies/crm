import { useEffect, useState } from 'react';

import { api, type Account, type Personality } from './api';
import { CapBar, Pill } from './ui';

const CAP_MIN = 0;
const CAP_MAX = 1000;

/**
 * A daily cap typed by an operator.
 *
 * Number('') is 0, not NaN, so a cleared field reads as a perfectly valid cap
 * of zero -- and a cap of zero is an account that will never be handed another
 * target. The field is therefore held as text and only committed once it parses
 * to a real number; anything else reverts to what the server already has.
 */
function parseCap(draft: string): number | null {
  if (draft.trim() === '') return null;
  const n = Number(draft);
  if (!Number.isFinite(n)) return null;
  return Math.min(CAP_MAX, Math.max(CAP_MIN, Math.round(n)));
}

/**
 * The main screen: every personality, its accounts, and how much of each
 * account's daily follow budget is spent.
 *
 * The cap bar is given more room than the raw numbers because it is the safety
 * feature -- an account handed more than its cap is an account at risk of being
 * limited or banned, and that has to be legible at a glance.
 */
export function Personalities({
  data,
  onOpen,
  onChanged,
}: {
  data: Personality[];
  onOpen: (p: Personality) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createPersonality(name.trim());
      setName('');
      onChanged();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel row-form">
        <input
          placeholder="new personality name, e.g. kris"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
        />
        <button className="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
          Create personality
        </button>
        {err && <span className="error">{err}</span>}
      </div>

      {data.length === 0 && (
        <p className="muted">No personalities yet. Create one above.</p>
      )}

      {data.map((p) => (
        <PersonalityCard key={p.id} p={p} onOpen={onOpen} onChanged={onChanged} />
      ))}
    </>
  );
}

function PersonalityCard({
  p,
  onOpen,
  onChanged,
}: {
  p: Personality;
  onOpen: (p: Personality) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [cap, setCap] = useState('25');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dailyCap = parseCap(cap);

  const addAccount = async () => {
    if (!label.trim() || dailyCap === null || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.addAccount(p.id, label.trim(), dailyCap);
      setLabel('');
      setCap('25');
      setAdding(false);
      onChanged();
    } catch (e) {
      // A duplicate label is the common one and it used to fail silently: the
      // form just sat there and the operator retyped it.
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>{p.name}</h2>
          <p className="muted small">
            {p.client} · {p.model} · <strong>{p.people}</strong> handles attached
          </p>
        </div>
        <div className="panel-actions">
          <button onClick={() => onOpen(p)}>View handles</button>
          <button onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add account'}
          </button>
        </div>
      </header>

      {adding && (
        <div className="row-form inset">
          <input
            placeholder="account label, e.g. kris_snap_04"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addAccount();
            }}
          />
          <label className="cap-input">
            daily cap
            <input
              type="number"
              className="mini"
              min={CAP_MIN}
              max={CAP_MAX}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          </label>
          <button
            className="primary"
            onClick={() => void addAccount()}
            disabled={busy || !label.trim() || dailyCap === null}
          >
            Add
          </button>
          {err && <span className="error">{err}</span>}
        </div>
      )}

      {p.accounts.length === 0 ? (
        <p className="muted small inset">
          No accounts yet — this personality cannot be handed any targets until it
          has one.
        </p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>account</th>
                <th className="cap-col">daily cap used</th>
                <th className="num">queued</th>
                <th className="num">handed out</th>
                <th className="num">followed</th>
                <th className="num">review</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {p.accounts.map((a) => (
                <AccountRow key={a.id} a={a} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AccountRow({ a, onChanged }: { a: Account; onChanged: () => void }) {
  const [draft, setDraft] = useState(String(a.dailyCap));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The row is not remounted by the 5s poll, so its own copy of the cap would
  // otherwise sit there contradicting the server for as long as the tab is
  // open. Adopt the server's value, but never over what is being typed.
  useEffect(() => {
    if (!editing) setDraft(String(a.dailyCap));
  }, [a.dailyCap, editing]);

  const save = async (patch: { dailyCap?: number; enabled?: boolean }) => {
    setSaving(true);
    setErr(null);
    try {
      await api.updateAccount(a.id, patch);
      onChanged();
    } catch (e) {
      // Leaving the rejected number in the box would show a cap the account
      // does not have, on the one control that decides how hard it gets pushed.
      setErr(e instanceof Error ? e.message : String(e));
      setDraft(String(a.dailyCap));
    } finally {
      setSaving(false);
    }
  };

  const commit = () => {
    setEditing(false);
    const next = parseCap(draft);
    if (next === null) {
      setDraft(String(a.dailyCap));
      return;
    }
    setDraft(String(next));
    if (next !== a.dailyCap) void save({ dailyCap: next });
  };

  return (
    <tr className={a.enabled ? '' : 'off'}>
      <td data-label="account">
        <code>{a.label}</code>
      </td>
      <td data-label="cap" className="cap-col">
        <CapBar used={a.handedToday} cap={a.dailyCap} />
      </td>
      <td data-label="queued" className="num">
        {a.queued || ''}
      </td>
      <td data-label="handed out" className="num">
        {a.handedOut || ''}
      </td>
      <td data-label="followed" className="num">
        {a.followed || ''}
      </td>
      <td data-label="review" className="num">
        {a.review ? <Pill value="review" /> : ''}
      </td>
      <td data-label="" className="actions">
        {err && <span className="error small">{err}</span>}
        <input
          type="number"
          className="mini"
          min={CAP_MIN}
          max={CAP_MAX}
          value={draft}
          disabled={saving}
          onFocus={() => setEditing(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          title="daily cap"
        />
        <button className="link" onClick={() => void save({ enabled: !a.enabled })}>
          {a.enabled ? 'pause' : 'resume'}
        </button>
      </td>
    </tr>
  );
}
