import { useEffect, useState } from 'react';

import { api, type Settings as SettingsValues } from './api';

/**
 * How hard to push every account, in one place.
 *
 * These two numbers used to live apart and neither was reachable from here: the
 * cap was a column on every account, edited one row at a time, and the pace was
 * `follow_pace_seconds` in a config file on each emulator box. Between them they
 * are the single decision that decides whether a Snapchat account survives, so
 * they are one screen.
 *
 * The important asymmetry, which the screen says out loud rather than hiding:
 * the cap is ENFORCED by this server -- the handout meters against it and a
 * machine that ignores it still gets nothing -- while the pace is only SERVED.
 * A machine has to honour it, and one running an older build will keep using its
 * own config file.
 */
const LIMITS = {
  dailyCapPerAccount: { min: 0, max: 2000 },
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
        setPace(String(s.followPaceSeconds));
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const nextCap = parse(cap, 'dailyCapPerAccount');
  const nextPace = parse(pace, 'followPaceSeconds');
  const dirty =
    saved !== null &&
    ((nextCap !== null && nextCap !== saved.dailyCapPerAccount) ||
      (nextPace !== null && nextPace !== saved.followPaceSeconds));

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const out = await api.saveSettings({
        ...(nextCap === null ? {} : { dailyCapPerAccount: nextCap }),
        ...(nextPace === null ? {} : { followPaceSeconds: nextPace }),
      });
      const next = {
        dailyCapPerAccount: out.dailyCapPerAccount,
        followPaceSeconds: out.followPaceSeconds,
      };
      setSaved(next);
      setCap(String(next.dailyCapPerAccount));
      setPace(String(next.followPaceSeconds));
      setNote('Saved. The cap applies to the next handout; the pace applies the next time each machine claims.');
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
            One setting for every account this client runs. There is no per-account cap.
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

      <div className="row-form inset">
        <button className="primary" onClick={() => void save()} disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {err && <span className="error">{err}</span>}
        {note && !err && <span className="muted small">{note}</span>}
      </div>

      <p className="muted small inset">
        A young account hits Snapchat&apos;s add-cooldown at roughly 40 adds a day in testing.
        These two numbers are the rate limit that keeps an account alive, not a throughput knob
        — if accounts start getting limited, this is the first screen to come back to.
      </p>
    </section>
  );
}
