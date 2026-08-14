import { useEffect, useState } from 'react';

import { api, type Settings as SettingsValues } from './api';

/**
 * How hard to push every account, in one place.
 *
 * These numbers used to live apart and none was reachable from here: the cap was
 * a column on every account, edited one row at a time, and the pace was
 * `follow_pace_seconds` in a config file on each emulator box. Between them they
 * are the single decision that decides whether a Snapchat account survives, so
 * they are one screen.
 *
 * The important asymmetry, which the screen says out loud rather than hiding:
 * the two caps are ENFORCED by this server -- the handout meters against both
 * and a machine that ignores them still gets nothing -- while the pace is only
 * SERVED. A machine has to honour it, and one running an older build will keep
 * using its own config file. The rows are ordered so that asymmetry reads
 * top-to-bottom: the enforced numbers together, the served one last.
 *
 * The model that reads the sheets is last of all, under its own heading. It is
 * not a pacing number, but it is the other decision made once for the whole
 * client, and the cheap default trades accuracy for cost -- so the measured
 * trade-off is printed above the Save button rather than left to be discovered
 * in the spend column or, worse, in who got followed.
 */
const LIMITS = {
  dailyCapPerAccount: { min: 0, max: 2000 },
  // 2000 mirrors the daily cap so the two caps are comparable at a glance.
  sessionCapPerAccount: { min: 0, max: 2000 },
  // min 1, not 0. A CAP of 0 pauses, which is a real answer the daily cap
  // already documents. A WINDOW of 0 counts nothing, so the cap beside it could
  // never bind: it would read as a setting while being off. max 1440 is exactly
  // one day, the value that turns the session cap into a second daily cap.
  sessionWindowMinutes: { min: 1, max: 1440 },
  followPaceSeconds: { min: 0, max: 3600 },
};

/** Held as text, committed as a number. Number('') is 0, and a cleared field
 *  meaning "cap of zero" would silently stop every account. */
function parse(draft: string, field: keyof typeof LIMITS): number | null {
  if (draft.trim() === '') return null;
  const n = Number(draft);
  if (!Number.isFinite(n)) return null;
  const { min, max } = LIMITS[field];
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function Settings() {
  const [saved, setSaved] = useState<SettingsValues | null>(null);
  const [cap, setCap] = useState('');
  const [sessionCap, setSessionCap] = useState('');
  const [model, setModel] = useState('');
  // Served, never hardcoded: the same reason the targeting screen takes its
  // vocabulary from the server. The set is checked server-side because an
  // unlisted model does not fail validation, it fails every extraction for this
  // client, and a list baked in here is a list that can drift out of step.
  const [models, setModels] = useState<string[]>([]);
  // Not `window`: this component has no other reason to touch the global, and a
  // shadow that only bites in a later edit is not worth the shorter name.
  const [windowMins, setWindowMins] = useState('');
  const [pace, setPace] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void api
      .settings()
      .then((s) => {
        setSaved(s);
        setCap(String(s.dailyCapPerAccount));
        // `?? ''` on the session pair only: settings() does no shape coercion,
        // so against a server that has not yet shipped these columns
        // String(undefined) would put the literal "undefined" into the field.
        // It renders blank in a number input and parse() drops it, so nothing
        // is saved -- but the state would be lying, and the next person to read
        // it would believe it.
        setSessionCap(String(s.sessionCapPerAccount ?? ''));
        setWindowMins(String(s.sessionWindowMinutes ?? ''));
        setPace(String(s.followPaceSeconds));
        // Same `??` guard and for the same reason as the pair above, and one
        // more besides: `String(undefined)` here would put "undefined" into a
        // <select> whose options do not contain it, which renders as the first
        // option and reads as a model this client is not using.
        setModel(String(s.extractionModel ?? ''));
        setModels(Array.isArray(s.models) ? s.models : []);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const nextCap = parse(cap, 'dailyCapPerAccount');
  const nextSessionCap = parse(sessionCap, 'sessionCapPerAccount');
  const nextWindow = parse(windowMins, 'sessionWindowMinutes');
  const nextPace = parse(pace, 'followPaceSeconds');
  // The !== null on every clause is what makes a cleared box mean "leave this
  // one alone" rather than "save a zero", which on either cap would stop work.
  const dirty =
    saved !== null &&
    ((nextCap !== null && nextCap !== saved.dailyCapPerAccount) ||
      (nextSessionCap !== null && nextSessionCap !== saved.sessionCapPerAccount) ||
      (nextWindow !== null && nextWindow !== saved.sessionWindowMinutes) ||
      (nextPace !== null && nextPace !== saved.followPaceSeconds) ||
      (model !== '' && model !== saved.extractionModel));

  // What is saved always appears, even if the server has stopped offering it.
  // A <select> whose value is not among its options shows the FIRST option
  // instead, so without this union the screen would display a model this client
  // is not using and merely opening the tab would make it look unchanged.
  const options = model === '' || models.includes(model) ? models : [model, ...models];

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const out = await api.saveSettings({
        ...(nextCap === null ? {} : { dailyCapPerAccount: nextCap }),
        ...(nextSessionCap === null ? {} : { sessionCapPerAccount: nextSessionCap }),
        ...(nextWindow === null ? {} : { sessionWindowMinutes: nextWindow }),
        ...(nextPace === null ? {} : { followPaceSeconds: nextPace }),
        ...(model === '' ? {} : { extractionModel: model }),
      });
      const next = {
        dailyCapPerAccount: out.dailyCapPerAccount,
        sessionCapPerAccount: out.sessionCapPerAccount,
        sessionWindowMinutes: out.sessionWindowMinutes,
        followPaceSeconds: out.followPaceSeconds,
        extractionModel: out.extractionModel,
      };
      setSaved(next);
      setCap(String(next.dailyCapPerAccount));
      setSessionCap(String(next.sessionCapPerAccount));
      setWindowMins(String(next.sessionWindowMinutes));
      setPace(String(next.followPaceSeconds));
      setModel(String(next.extractionModel ?? ''));
      setNote(
        'Saved. Both caps apply to the next handout and the model to the next sheet extracted; the pace applies the next time each machine claims.',
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!saved && !err) return <p className="muted">loading…</p>;

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Pacing</h2>
          <p className="muted small">
            Everything here applies to every account this client runs. There are no per-account
            caps, and one model reads every sheet.
          </p>
        </div>
      </header>

      <div className="row-form inset">
        <label className="cap-input">
          follow cap
          <input
            type="number"
            className="mini"
            min={LIMITS.dailyCapPerAccount.min}
            max={LIMITS.dailyCapPerAccount.max}
            value={cap}
            disabled={busy}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
        <span className="muted small">
          targets handed to <strong>each</strong> account per day. Enforced here: the handout
          stops at this number whatever a machine asks for. 0 pauses every account at once.
        </span>
      </div>

      <div className="row-form inset">
        <label className="cap-input">
          session cap
          <input
            type="number"
            className="mini"
            min={LIMITS.sessionCapPerAccount.min}
            max={LIMITS.sessionCapPerAccount.max}
            value={sessionCap}
            disabled={busy}
            onChange={(e) => setSessionCap(e.target.value)}
          />
        </label>
        <span className="muted small">
          the most any <strong>one</strong> account is handed inside the window below. Enforced
          here. This is what lets a machine work one account, then move to the next.
        </span>
      </div>

      <div className="row-form inset">
        <label className="cap-input">
          window minutes
          <input
            type="number"
            className="mini"
            min={LIMITS.sessionWindowMinutes.min}
            max={LIMITS.sessionWindowMinutes.max}
            value={windowMins}
            disabled={busy}
            onChange={(e) => setWindowMins(e.target.value)}
          />
        </label>
        <span className="muted small">
          how long that window is, rolling. 1440 turns the session cap into a second daily cap.
        </span>
      </div>

      <div className="row-form inset">
        <label className="cap-input">
          seconds between follows
          <input
            type="number"
            className="mini"
            min={LIMITS.followPaceSeconds.min}
            max={LIMITS.followPaceSeconds.max}
            value={pace}
            disabled={busy}
            onChange={(e) => setPace(e.target.value)}
          />
        </label>
        <span className="muted small">
          sent to the machines, which jitter it ±25%. Only a machine can honour this — one
          running an older build keeps using its own config file.
        </span>
      </div>

      <div className="row-form">
        <h3>Sheet reading</h3>
      </div>

      <div className="row-form inset">
        <label className="cap-input">
          model
          <select
            className="model-select"
            value={model}
            disabled={busy || options.length === 0}
            onChange={(e) => setModel(e.target.value)}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">
          which model reads every sheet. The list is closed server-side — anything else would
          fail every extraction.
        </span>
      </div>

      {/* One line, not the scored table that was here. The table was three
          rows and three paragraphs of caveat for a decision taken once; the
          number that actually changes the decision is the leak count, and it
          fits on a line. The full matrix lives in vlm_eval/FORMAT-AB.md. */}
      <p className="muted small inset">
        Cheap model: <strong>3 of 5</strong> women let through and $0.0233 a sheet, against{' '}
        <strong>1 of 5</strong> and $0.1282 for <code>gemini-3.6-flash</code>. One scored run of
        99 profiles, so five is the whole sample.
      </p>

      <div className="row-form inset">
        <button className="primary" onClick={() => void save()} disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {err && <span className="error">{err}</span>}
        {note && !err && <span className="muted small">{note}</span>}
      </div>

      <p className="muted small inset">
        A young account hits Snapchat&apos;s add-cooldown at roughly 40 adds a day in testing.
        These are the rate limit that keeps an account alive, not a throughput knob.
      </p>
    </section>
  );
}
