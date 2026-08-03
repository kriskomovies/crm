import { useState } from 'react';

import { api, type Account, type Personality } from './api';
import { CapBar } from './ui';

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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addAccount = async () => {
    if (!label.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.addAccount(p.id, label.trim());
      setLabel('');
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
          <button
            className="primary"
            onClick={() => void addAccount()}
            disabled={busy || !label.trim()}
          >
            Add
          </button>
          {err && <span className="error">{err}</span>}
          <span className="muted small">
            metered at the client&apos;s cap — change it on Settings
          </span>
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
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Pause and resume is all that is left here. The cap moved to Settings: it is
  // one number for the whole client, and twenty rows each offering to edit it
  // was twenty places to set it and nineteen chances to leave one behind.
  const save = async (patch: { enabled?: boolean }) => {
    setSaving(true);
    setErr(null);
    try {
      await api.updateAccount(a.id, patch);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
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
      <td data-label="" className="actions">
        {err && <span className="error small">{err}</span>}
        <button
          className="link"
          disabled={saving}
          onClick={() => void save({ enabled: !a.enabled })}
        >
          {a.enabled ? 'pause' : 'resume'}
        </button>
      </td>
    </tr>
  );
}
