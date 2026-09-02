/**
 * Landing / sign-in page. Google sign-in is the way in, kept prominent in a hero card (and repeated
 * under the demos); the username + password form exists for accounts an administrator created
 * (seeded users, e2e) and stays folded away behind a small link while Google is available.
 *
 * The demo clips (packages/client/public/landing/*) are real recordings of the editor, made by
 * scripts/recording/. Each exists in a light and a dark variant; the page shows the one matching
 * the visitor's theme. A clip plays once when scrolled into view and halts on its last frame with
 * a replay button.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Wordmark } from './Logo';
import { api, type User } from '../api';
import { useTheme } from './theme';
import './landing.css';

export const GITHUB_URL = 'https://github.com/japhba/overlyx';

const GoogleG = () => (
  <svg class="g" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

const GoogleButton = () => (
  <a class="google" href="/api/auth/google" data-google-login><GoogleG /><span>Continue with Google</span></a>
);

/**
 * One demo clip: plays once when it scrolls into view, halts on the last frame, and offers a
 * replay button. The light or dark recording is picked to match the visitor's theme.
 */
function Demo({ name, title, note, big, children }: { name: string; title: string; note: string; big?: boolean; children?: ComponentChildren }) {
  const { theme } = useTheme();
  const ref = useRef<HTMLVideoElement>(null);
  const [ended, setEnded] = useState(false);
  const src = `/landing/${name}-${theme}`;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    setEnded(false);
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting && !v.ended) void v.play().catch(() => {});
        else if (!e.isIntersecting && !v.paused) v.pause();
      }
    }, { threshold: 0.35 });
    io.observe(v);
    return () => io.disconnect();
  }, [src]);
  const replay = () => {
    const v = ref.current;
    if (!v) return;
    setEnded(false);
    v.currentTime = 0;
    void v.play().catch(() => {});
  };
  return (
    <figure class={'demo' + (big ? ' big' : '')} data-demo={name}>
      <div class={'frame' + (ended ? ' ended' : '')}>
        {/* key: a theme flip swaps the sources, which <video> only picks up on a fresh element */}
        <video key={src} ref={ref} muted playsInline preload="metadata" poster={src + '.jpg'}
          onEnded={() => setEnded(true)} onPlay={() => setEnded(false)}>
          <source src={src + '.webm'} type="video/webm" />
          <source src={src + '.mp4'} type="video/mp4" />
        </video>
        {ended && (
          <button type="button" class="replay" data-replay onClick={replay} aria-label={'Replay: ' + title}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 5V2L7 6.5 12 11V7.5a5.5 5.5 0 1 1-5.5 5.5H4a8 8 0 1 0 8-8z" /></svg>
            Replay
          </button>
        )}
      </div>
      <figcaption><strong>{title}</strong><span>{note}{children}</span></figcaption>
    </figure>
  );
}

export function Login({ onLogin, google }: { onLogin: (u: User) => void; google: boolean }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // the password form is the fallback: folded away while Google sign-in is offered
  const [wantPassword, setWantPassword] = useState(false);
  const showPassword = wantPassword || !google;
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { const r = await api.login(username, password); onLogin(r.user); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  };
  return (
    <div class="login">
      <div class="landing">
        <header class="hero">
          <div class="hero-copy">
            <h1><Wordmark /></h1>
            <p class="tagline"><strong>Overleaf&nbsp;+&nbsp;LyX</strong> — collaborative WYSIWYG editing for LaTeX documents.</p>
            <ul class="pitch" aria-label="Why OverLyX">
              <li><strong>WYSIWYG editing</strong><span>text and formulas render as you type — no compile loop</span></li>
              <li><strong>Native .tex</strong><span>plain LaTeX files, kept byte for byte — git and your other tools just work</span></li>
              <li><strong>Multi-author collaboration</strong><span>live editing, change tracking, comments, sharing</span></li>
              <li><strong>Offline support</strong><span>edits keep going without a connection and merge when you're back</span></li>
            </ul>
            <nav class="links" aria-label="About OverLyX">
              <a href={GITHUB_URL} target="_blank" rel="noopener">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
                GitHub
              </a>
              <a href={GITHUB_URL + '/issues/new'} target="_blank" rel="noopener">Report an issue</a>
            </nav>
          </div>
          <form class="signin" onSubmit={submit}>
            <h2>Get started</h2>
            <p class="signin-note">Sign in and your first project is one click away.</p>
            {google && <GoogleButton />}
            {google && !showPassword && (
              <button type="button" class="fallback-link" data-password-login onClick={() => setWantPassword(true)}>
                I have a username and password
              </button>
            )}
            {showPassword && (
              <div class={'password' + (google ? ' fallback' : '')}>
                {google && <div class="fallback-note">Only for accounts an administrator created. With a Google account, use the button above.</div>}
                <input placeholder="Username" value={username} onInput={e => setUsername((e.target as HTMLInputElement).value)} autocomplete="username" autofocus />
                <input placeholder="Password" type="password" value={password} onInput={e => setPassword((e.target as HTMLInputElement).value)} autocomplete="current-password" />
                {err && <div class="err">{err}</div>}
                <button class={'btn' + (google ? '' : ' primary')} disabled={busy}>Sign in</button>
              </div>
            )}
            <a class="demos-hint" href="#demos">▾ See it in action</a>
          </form>
        </header>
        <section class="demos" id="demos" aria-label="What OverLyX can do">
          <h2>See it in action</h2>
          <Demo big name="wysiwyg" title="True WYSIWYG, for text and math"
            note="Sections, prose and formulas render as you type them — no compile loop, no raw markup." />
          <div class="demo-grid">
            <Demo name="tex" title="It's a real .tex file"
              note="The document is plain LaTeX, kept byte for byte. Open the source beside the page and edit either side — they stay in sync." />
            <Demo name="collab" title="Write together"
              note="Live cursors and presence across authors — with change tracking, comments and sharing built in." />
          </div>
          <Demo big name="vscode" title="WYSIWYG for your VS Code LaTeX writing"
            note="The same editor as a VS Code extension: rendered .tex documents, PDF preview with SyncTeX — while files, git and agents stay VS Code's. ">
            <a href={GITHUB_URL + '/releases/latest'} target="_blank" rel="noopener">Get the extension.</a>
          </Demo>
        </section>
        <div class="cta-end">
          <p>Your next paper deserves a nicer editor.</p>
          {google ? <a class="google" href="/api/auth/google"><GoogleG /><span>Continue with Google</span></a>
            : <a class="google" href="#top" onClick={e => { e.preventDefault(); document.querySelector('.login')?.scrollTo({ top: 0, behavior: 'smooth' }); }}>Sign in above</a>}
        </div>
      </div>
    </div>
  );
}
