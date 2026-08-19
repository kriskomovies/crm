import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type Personality } from './api';
import { Followed } from './Followed';
import { Import } from './Import';
import { Login } from './Login';
import { Personalities } from './Personalities';
import { Settings } from './Settings';
import { Sheets } from './Sheets';
import { Stats } from './Stats';
import { Targeting } from './Targeting';
import { Targets } from './Targets';

type View =
  | { tab: 'personalities'; open: Personality | null }
  | { tab: 'followed' }
  | { tab: 'stats' }
  | { tab: 'sheets' }
  | { tab: 'targeting' }
  | { tab: 'import' }
  | { tab: 'settings' };

export default function App() {
  // null = not asked yet. Rendering the app or the login before the answer
  // arrives makes a logged-in operator watch the login flash past on reload.
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [view, setView] = useState<View>({ tab: 'personalities', open: null });
  const [data, setData] = useState<Personality[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The rail collapses to icons only. It is remembered because this app is
  // meant to be left open on a second monitor all day -- re-collapsing it on
  // every reload is a small annoyance repeated forever.
  const [tight, setTight] = useState(() => localStorage.getItem('sidebar') === 'tight');
  const [leaving, setLeaving] = useState(false);

  const collapse = () => {
    const next = !tight;
    setTight(next);
    localStorage.setItem('sidebar', next ? 'tight' : 'wide');
  };

  const signOut = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await api.logout();
    } finally {
      // Either the cookie is gone or the server is unreachable. The operator
      // asked to leave, and the login screen is the honest place to put them
      // either way -- the session is checked again on the next request.
      setAuthed(false);
    }
  };

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
    <div className={tight ? 'app tight' : 'app'}>
      <aside className="sidebar">
        <h1 className="brand">
          <span className={err ? 'dot dot-bad' : 'dot'} title={err ?? 'connected'} />
          <span className="navlabel">Follow targets</span>
        </h1>
        <nav>
          <button
            className={view.tab === 'personalities' ? 'on' : ''}
            onClick={() => setView({ tab: 'personalities', open: null })}
            title="Personalities"
          >
            <IconPeople />
            <span className="navlabel">Personalities</span>
          </button>
          <button
            className={view.tab === 'followed' ? 'on' : ''}
            onClick={() => setView({ tab: 'followed' })}
            title="Followed"
          >
            <IconCheck />
            <span className="navlabel">Followed</span>
          </button>
          <button
            className={view.tab === 'stats' ? 'on' : ''}
            onClick={() => setView({ tab: 'stats' })}
            title="Stats"
          >
            <IconChart />
            <span className="navlabel">Stats</span>
          </button>
          <button
            className={view.tab === 'sheets' ? 'on' : ''}
            onClick={() => setView({ tab: 'sheets' })}
            title="Sheets"
          >
            <IconGrid />
            <span className="navlabel">Sheets</span>
          </button>
          <button
            className={view.tab === 'targeting' ? 'on' : ''}
            onClick={() => setView({ tab: 'targeting' })}
            title="Targeting"
          >
            <IconTarget />
            <span className="navlabel">Targeting</span>
          </button>
          <button
            className={view.tab === 'import' ? 'on' : ''}
            onClick={() => setView({ tab: 'import' })}
            title="Import"
          >
            <IconUpload />
            <span className="navlabel">Import</span>
          </button>
          <button
            className={view.tab === 'settings' ? 'on' : ''}
            onClick={() => setView({ tab: 'settings' })}
            title="Settings"
          >
            <IconSliders />
            <span className="navlabel">Settings</span>
          </button>
        </nav>

        <div className="sidebar-foot">
          <button className="collapse" onClick={collapse} title={tight ? 'Expand' : 'Collapse'}>
            <IconCollapse tight={tight} />
            <span className="navlabel">Collapse</span>
          </button>
          <button onClick={() => void signOut()} disabled={leaving} title="Log out">
            <IconExit />
            <span className="navlabel">{leaving ? 'Logging out…' : 'Logout'}</span>
          </button>
        </div>
      </aside>

      <div className="content">
        {err && <p className="error banner">API unreachable — {err}</p>}
        {!data && !err && <p className="muted">loading…</p>}

        <main>
          {view.tab === 'followed' && <Followed personalities={data ?? []} />}

          {view.tab === 'stats' && <Stats personalities={data ?? []} />}

          {view.tab === 'sheets' && <Sheets />}

          {view.tab === 'targeting' && <Targeting />}

          {view.tab === 'import' && <Import />}

          {view.tab === 'settings' && <Settings />}

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
    </div>
  );
}

/* Sixteen-pixel strokes on currentColor, so an icon is whatever colour its
   button is -- muted at rest, full text when the tab is on. `aria-hidden`
   because every one of them sits next to its own word; when the rail is
   collapsed that word is still in the DOM, only visually hidden. */
const stroke16 = {
  viewBox: '0 0 16 16',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function IconPeople() {
  return (
    <svg {...stroke16}>
      <circle cx="6.2" cy="5.4" r="2.4" />
      <path d="M1.8 13.4c0-2.3 2-3.7 4.4-3.7s4.4 1.4 4.4 3.7" />
      <path d="M11.2 3.4a2.4 2.4 0 0 1 0 4" />
      <path d="M14.2 13.4c0-1.8-.9-2.9-2.3-3.4" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg {...stroke16}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M5.2 8.2 7.2 10.2 10.9 6.1" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg {...stroke16}>
      <path d="M2.2 13.6h11.6" />
      <path d="M4.6 13.6V8.4" />
      <path d="M8 13.6V3.4" />
      <path d="M11.4 13.6V6.2" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg {...stroke16}>
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.4" />
      <path d="M2.2 6.4h11.6" />
      <path d="M6.6 6.4v6.8" />
    </svg>
  );
}

function IconTarget() {
  return (
    <svg {...stroke16}>
      <circle cx="8" cy="8" r="5.4" />
      <circle cx="8" cy="8" r="1.9" />
      <path d="M8 .9v1.7M8 13.4v1.7M.9 8h1.7M13.4 8h1.7" />
    </svg>
  );
}

function IconSliders() {
  return (
    <svg {...stroke16}>
      <path d="M2.4 4.6h11.2M2.4 11.4h11.2" />
      <circle cx="6" cy="4.6" r="1.7" />
      <circle cx="10.6" cy="11.4" r="1.7" />
    </svg>
  );
}

/* Points the way the rail is about to move, not the way it currently sits. */
function IconCollapse({ tight }: { tight: boolean }) {
  return (
    <svg {...stroke16}>
      <path d="M2.6 3.2v9.6" />
      {tight ? <path d="M6.4 8h7.2M10.2 4.8 13.6 8l-3.4 3.2" /> : <path d="M13.6 8H6.4M9.8 4.8 6.4 8l3.4 3.2" />}
    </svg>
  );
}

function IconExit() {
  return (
    <svg {...stroke16}>
      <path d="M9.8 2.8H4.2a1.4 1.4 0 0 0-1.4 1.4v7.6a1.4 1.4 0 0 0 1.4 1.4h5.6" />
      <path d="M12 5.6 14.4 8 12 10.4" />
      <path d="M14.4 8H6.8" />
    </svg>
  );
}

/* A file going up: the tray, and the arrow leaving it. */
function IconUpload() {
  return (
    <svg {...stroke16}>
      <path d="M2.6 10.4v2a1.4 1.4 0 0 0 1.4 1.4h8a1.4 1.4 0 0 0 1.4-1.4v-2" />
      <path d="M8 10.2V2.4" />
      <path d="M5.2 5.2 8 2.4l2.8 2.8" />
    </svg>
  );
}
