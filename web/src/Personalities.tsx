import { useState } from 'react';

import { api, type Account, type CapReset, type Personality } from './api';
import { CapBar, HealthPill, ONBOARD_TARGET, PhasePill } from './ui';

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
                  <th title="Where this account is in its life. A bought account is wiped first — contacts, chats, then friends — and is handed nobody until that finishes. Then it is seeded by search until it has 50 adds of its own, after which the ordinary Quick Add walk takes over.">
                    onboarding
                  </th>
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
  // Deleting is kept on its own confirmation rather than sharing the cap
  // reset's. They read alike in a table and one of them cannot be undone.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  // Marking an account onboarded also asks first, because the two answers mean
  // different things and picking the wrong one is not free: telling the server
  // an unwiped account is established leaves the previous owner's friends on it
  // for good, since nothing will ever be told to clear them.
  const [claiming, setClaiming] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markErr, setMarkErr] = useState<string | null>(null);

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

  const markOnboarded = async (to: 'seeding' | 'established') => {
    setMarking(true);
    setMarkErr(null);
    try {
      await api.markOnboarded(a.id, to);
      setClaiming(false);
      onChanged();
    } catch (e) {
      setMarkErr(e instanceof Error ? e.message : String(e));
    } finally {
      setMarking(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteErr(null);
    try {
      await api.deleteAccount(a.id);
      // No success state to show: the row it would have rendered in is gone.
      onChanged();
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
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
        {/* Beside health rather than folded into it. An account being wiped is
            not unhealthy, it is early -- and the two answer different questions:
            health is about whether Snapchat is refusing this account, this is
            about whether the account is ready to be asked yet. An account below
            `seeding` is handed nothing, so without this column a wipe in
            progress and a stalled agent look identical. */}
        <td data-label="onboarding">
          <PhasePill a={a} />
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
          {/* Hidden once the account IS established: there is nothing left to
              skip, and a button that silently does nothing is worse than no
              button. */}
          {a.phase !== 'established' && (
            <button
              className="link"
              disabled={marking}
              onClick={() => {
                setMarkErr(null);
                setClaiming((v) => !v);
              }}
            >
              {claiming ? 'keep it' : 'onboarded'}
            </button>
          )}
          <button
            className="link danger"
            disabled={deleting}
            onClick={() => {
              setAsking(false);
              setDeleteErr(null);
              setConfirmDelete((v) => !v);
            }}
          >
            {confirmDelete ? 'keep it' : 'remove'}
          </button>
        </td>
      </tr>

      {/* A second row rather than something crammed into the actions cell: what
          this button does needs a sentence before it fires, and a sentence does
          not fit in a column that is mostly numbers. */}
      {(asking || freed || resetErr || confirmDelete || deleteErr || claiming || markErr) && (
        <tr>
          {/* Eight columns: account, status, cap, queued, followed, failed today,
              already followed, actions. */}
          <td className="rowdetail" data-label="" colSpan={9}>
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

            {claiming && (
              <>
                <p className="rowdetail-p">
                  How far along is <code>{a.label}</code> really? A bought account starts by
                  being wiped — contacts, chats, then friends — and is handed{' '}
                  <strong>nobody</strong> until that is reported done. If you cleared it
                  yourself, say so here and it stops waiting for a report that is never
                  coming.
                </p>
                <p className="rowdetail-p muted">
                  Neither answer can send an account backwards, so there is no way to ask for
                  a wipe from this page. Whatever this account has already added is kept.
                </p>
                {markErr && <p className="error small">{markErr}</p>}
                <div className="rowdetail-actions">
                  <button
                    className="primary"
                    disabled={marking}
                    onClick={() => void markOnboarded('seeding')}
                  >
                    {marking ? 'Saving…' : 'I cleared it — start adding by search'}
                  </button>
                  <button disabled={marking} onClick={() => void markOnboarded('established')}>
                    It is fully onboarded — go straight to Quick Add
                  </button>
                  <button disabled={marking} onClick={() => setClaiming(false)}>
                    Cancel
                  </button>
                </div>
                <p className="rowdetail-p muted">
                  “Fully onboarded” also counts this account as having its {ONBOARD_TARGET} searched adds,
                  because that number — not the label above — is what decides whether the
                  server hands it names to search for or a roster to walk.
                </p>
              </>
            )}

            {confirmDelete && (
              <>
                <p className="rowdetail-p">
                  Delete <code>{a.label}</code>? This <strong>cannot be undone</strong>. Its{' '}
                  {a.followed} follow{a.followed === 1 ? '' : 's'}, its {a.queued} queued row
                  {a.queued === 1 ? '' : 's'} and every sheet it uploaded go with it, and the
                  uploaded images are purged from storage.
                </p>
                <p className="rowdetail-p muted">
                  The people themselves stay — they belong to the personality, not to this
                  account. Losing their assignments is what frees them to be handed to a
                  sibling account, which is usually the reason to do this. Nothing changes on
                  Snapchat: anyone this account already added stays added.
                </p>
                <div className="rowdetail-actions">
                  <button className="danger" disabled={deleting} onClick={() => void remove()}>
                    {deleting ? 'Deleting…' : `Delete ${a.label}`}
                  </button>
                  <button disabled={deleting} onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </div>
              </>
            )}

            {deleteErr && <p className="rowdetail-p error">{deleteErr}</p>}

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
