import { useState } from 'react';

import { api, type Account, type CapReset, type Personality } from './api';
import { CapBar, HealthPill } from './ui';

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
            {p.client} · <strong>{p.people}</strong> handles attached
            {p.rejected > 0 && (
              <>
                {' · '}
                <strong>{p.rejected}</strong>{' '}
                <span title="Dropped by the filter and never offered to any account. A personality-wide number: a refusal leaves a person with no assignment, so there is no account to attribute it to.">
                  rejected by the filter
                </span>
              </>
            )}
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
        <>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>account</th>
                  <th>status</th>
                  <th className="cap-col">daily cap used</th>
                  {/* The three counts that need explaining carry it in a title
                      rather than in prose under the table. The prose was two
                      paragraphs, and it repeated under every personality card --
                      three personalities meant reading it three times to learn
                      nothing new. */}
                  <th className="num">queued</th>
                  <th className="num">followed</th>
                  <th className="num" title="Attempts this account made today that missed. Not lost: the row goes back in the queue and is offered again tomorrow, or immediately after a cap reset. It is not retried the same day, because the attempt still counts against the cap.">
                    failed today
                  </th>
                  <th className="num" title="Handles a sibling account of this personality already followed. One person can be assigned once, so this account can never be handed them.">
                    already followed
                  </th>
                  <th className="num" title="Handles the filter dropped, so no account was ever given them. A personality-wide number: a drop leaves a person with no assignment, so it reads the same on every row of this card.">
                    dropped
                  </th>
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
        </>
      )}
    </section>
  );
}

function AccountRow({ a, onChanged }: { a: Account; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The reset asks first and then reports, so it needs its own three states.
  // Kept apart from `err` above so a failed pause does not open the reset panel
  // and a pending reset does not swallow a pause error.
  const [asking, setAsking] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetErr, setResetErr] = useState<string | null>(null);
  const [freed, setFreed] = useState<CapReset | null>(null);

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

  const reset = async () => {
    if (resetting) return;
    setResetting(true);
    setResetErr(null);
    try {
      const out = await api.resetDailyCap(a.id);
      setAsking(false);
      // Held on screen rather than folded into a toast: the two counts are the
      // whole point of the button, and the row behind them refreshes on the
      // next poll, which would take the only evidence with it.
      setFreed(out);
      onChanged();
    } catch (e) {
      setResetErr(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <tr className={a.enabled ? '' : 'off'}>
        <td data-label="account">
          <code>{a.label}</code>
        </td>
        {/* Why this row is worth looking at, worked out from the counts printed
            further along it. An account being refused adds used to look exactly
            like one having a quiet morning. */}
        <td data-label="status">
          <HealthPill a={a} />
        </td>
        {/* The bar is follows LANDED, not slots handed out. A slot is charged
            at handout, so a row the walk never reached spends one and adds
            nobody -- this account read 240/240 on a day it followed 196 people.
            The handout figure trails behind as a fainter lead, and the gap
            between the two is exactly the number of slots that bought nothing. */}
        <td
          data-label="cap"
          className="cap-col"
          title={`${a.followedToday} followed today of a ${a.dailyCap} cap; ${a.handedToday} cap slots taken`}
        >
          <CapBar used={a.followedToday} cap={a.dailyCap} landed={a.handedToday} />
        </td>
        <td data-label="queued" className="num">
          {a.queued || ''}
        </td>
        <td data-label="followed" className="num">
          {a.followed || ''}
        </td>
        {/* Today, not all-time, unlike every other count on this row -- a
            failure is put back in the queue rather than parked in a failed
            state, so there is nothing to total up over time. The header and the
            note under the table both carry the scope; the title is for whoever
            hovers before reading either. */}
        <td
          data-label="failed today"
          className="num"
          title="attempts today that came back failed — the row went back in the queue and is offered again tomorrow, or immediately after a cap reset"
        >
          {a.failedToday || ''}
        </td>
        <td
          data-label="already followed"
          className="num"
          title="followed under a sibling account of this personality, so this one can never be handed them"
        >
          {a.alreadyFollowed || ''}
        </td>
        {/* Personality-wide, so it prints the same figure on every row of the
            card -- muted for exactly that reason. It is here because the roster
            has to add up: what the walk met was followed, already held, or
            dropped, and dropped was the only one of the three with nowhere to
            be read. */}
        <td
          data-label="dropped"
          className="num muted"
          title="dropped by the filter, so no account was ever given them — a personality-wide number"
        >
          {a.rejected || ''}
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
          <button
            className="link"
            disabled={resetting}
            onClick={() => {
              setFreed(null);
              setResetErr(null);
              setAsking((v) => !v);
            }}
          >
            {asking ? 'keep it' : 'reset cap'}
          </button>
        </td>
      </tr>

      {/* A second row rather than something crammed into the actions cell: what
          this button does needs a sentence before it fires, and a sentence does
          not fit in a column that is mostly numbers. */}
      {(asking || freed || resetErr) && (
        <tr>
          <td className="rowdetail" data-label="" colSpan={8}>
            {asking && (
              <>
                <p className="rowdetail-p">
                  Clear today&apos;s handouts on <code>{a.label}</code>? This is for running the
                  same test twice in one day: the {a.handedToday} target
                  {a.handedToday === 1 ? '' : 's'} it was given today stop counting against its
                  cap, so it can be handed up to {a.dailyCap} again. Anyone already followed{' '}
                  <strong>stays followed</strong> — nothing is un-followed and nobody is offered
                  twice. Rows a machine claimed and never reported on go back in the queue,
                  which is the only way they ever become workable again.
                </p>
                <p className="rowdetail-p muted">
                  It resets this server&apos;s bookkeeping, not Snapchat&apos;s. An account that
                  has already done 200 adds today meets the same add-cooldown after this as
                  before it — the only difference is that it will now be handed more people to
                  spend against a cooldown that has not lifted.
                </p>
                <div className="rowdetail-actions">
                  <button className="primary" disabled={resetting} onClick={() => void reset()}>
                    {resetting ? 'Resetting…' : "Reset today's cap"}
                  </button>
                  <button disabled={resetting} onClick={() => setAsking(false)}>
                    Cancel
                  </button>
                </div>
              </>
            )}

            {resetErr && <p className="rowdetail-p error">{resetErr}</p>}

            {freed && !asking && (
              <p className="rowdetail-p">
                {freed.cleared === 0 ? (
                  <>
                    Nothing to free on <code>{freed.label}</code> — it has not been handed
                    anyone today.
                  </>
                ) : (
                  <>
                    Freed {freed.cleared} of today&apos;s handouts on <code>{freed.label}</code>
                    {freed.requeued > 0 && (
                      <>
                        , {freed.requeued} of them claimed by a machine and never reported back
                      </>
                    )}
                    . It can be handed {freed.remainingToday} more today.
                  </>
                )}{' '}
                <button className="link" onClick={() => setFreed(null)}>
                  dismiss
                </button>
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
