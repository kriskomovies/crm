import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type Personality } from './api';
import { Login } from './Login';
import { Personalities } from './Personalities';
import { Sheets } from './Sheets';
import { Stats } from './Stats';
import { Targets } from './Targets';

type View =
  | { tab: 'personalities'; open: Personality | null }
  | { tab: 'stats' }
  | { tab: 'sheets' };

export default function App() {
  // null = not asked yet. Rendering the app or the login before the answer
  // arrives makes a logged-in operator watch the login flash past on reload.
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [view, setView] = useState<View>({ tab: 'personalities', open: null });
  const [data, setData] = useState<Personality[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Every load takes a ticket and only the newest one is allowed to write. The
  // poll fires every 5s regardless of how long a response takes, so a slow
  // request landing behind a fast one would otherwise reinstate stale counts --
  // and a manual refresh after a mutation would lose to the poll it overtook.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const items = await api.personalities();
      if (mine !== seq.current) return;
      setData(items);
      setErr(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // The overview is small and fixed-cost on the server, so polling it is cheap.
  // The target list is not polled -- see Targets.tsx.
  // Ask once on mount. A failure here means the API is unreachable, which is
  // not the same as being signed out -- but showing the login is the only
  // useful thing to offer either way.
  useEffect(() => {
    void api
      .session()
      .then((s) => setAuthed(s.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load, authed]);

  // Re-resolve the open personality from fresh data so its counts stay live
  // while drilled in, rather than freezing at whatever they were on entry. If
  // it has been deleted it resolves to null and the list comes back, instead of
  // stranding the operator on a ghost that can never update again.
  const open =
    view.tab === 'personalities' && view.open
      ? data
        ? (data.find((p) => p.id === view.open!.id) ?? null)
        : view.open
      : null;

  // Nothing at all until the session answer lands. Rendering either half early
  // makes a signed-in operator watch the login flash past on every reload.
  if (authed === null) return null;
  if (!authed) return <Login onIn={() => setAuthed(true)} />;

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          Follow targets
          <span className={err ? 'dot dot-bad' : 'dot'} title={err ?? 'connected'} />
        </h1>
        <nav>
          <button
            className={view.tab === 'personalities' ? 'on' : ''}
            onClick={() => setView({ tab: 'personalities', open: null })}
          >
            Personalities
          </button>
          <button
            className={view.tab === 'stats' ? 'on' : ''}
            onClick={() => setView({ tab: 'stats' })}
          >
            Stats
          </button>
          <button
            className={view.tab === 'sheets' ? 'on' : ''}
            onClick={() => setView({ tab: 'sheets' })}
          >
            Sheets
          </button>
        </nav>
      </header>

      {err && <p className="error banner">API unreachable — {err}</p>}
      {!data && !err && <p className="muted">loading…</p>}

      <main>
        {view.tab === 'stats' && <Stats personalities={data ?? []} />}

        {view.tab === 'sheets' && <Sheets />}

        {view.tab === 'personalities' &&
          data &&
          (open ? (
            // Keyed by id so switching personality remounts rather than reuses:
            // the previous one's rows, filters and attach result all belong to a
            // different ledger and must not carry over.
            <Targets
              key={open.id}
              p={open}
              onBack={() => setView({ tab: 'personalities', open: null })}
            />
          ) : (
            <Personalities
              data={data}
              onOpen={(p) => setView({ tab: 'personalities', open: p })}
              onChanged={() => void load()}
            />
          ))}
      </main>
    </div>
  );
}
