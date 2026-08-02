/**
 * The operator login.
 *
 * Replaces the browser's basic-auth prompt, which could not be styled, could
 * not explain a failure, and could not be logged out of without closing the
 * browser -- so a wrong password looked like the site was broken.
 *
 * The password goes to POST /api/session and nothing else. What comes back is
 * an HttpOnly cookie, so this component never holds a credential and no script
 * on the page can read one.
 */
import { useEffect, useRef, useState } from 'react';

import { api } from './api';

export function Login({ onIn }: { onIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  // Focus on arrival: this is the only thing on the page, and asking someone to
  // click into the one field that exists is a small daily annoyance.
  useEffect(() => first.current?.focus(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.login(username, password);
      onIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPassword('');
      // Back to the password, not the username: the username is almost always
      // right and retyping it is friction for no reason.
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>snap CRM</h1>
        <p className="muted">Operator sign in</p>

        <label>
          Username
          <input
            ref={first}
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {err && <div className="login-err">{err}</div>}

        <button type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
