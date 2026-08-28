import { useState } from 'preact/hooks';
import { Logo } from './Logo';
import { api, type User } from '../api';

export function Login({ onLogin, google }: { onLogin: (u: User) => void; google: boolean }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { const r = await api.login(username, password); onLogin(r.user); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  };
  return (
    <div class="login">
      <form onSubmit={submit}>
        <h1><Logo size={30} /> OverLyX</h1>
        <div style="color:#666;font-size:12px;margin-bottom:6px">Write LaTeX together — in LyX files, without the compiling.</div>
        <input placeholder="Username" value={username} onInput={e => setUsername((e.target as HTMLInputElement).value)} autocomplete="username" autofocus />
        <input placeholder="Password" type="password" value={password} onInput={e => setPassword((e.target as HTMLInputElement).value)} autocomplete="current-password" />
        {err && <div class="err">{err}</div>}
        <button class="btn primary" disabled={busy}>Sign in</button>
        {google && <a class="google" href="/api/auth/google">Sign in with Google</a>}
      </form>
    </div>
  );
}
