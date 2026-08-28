import './app/theme';   // sets data-theme on <html> before anything renders
import { render } from 'preact';
import { App } from './app/App';
import { editorContext } from './editor/context';
import { api } from './api';
import './styles.css';
import 'katex/dist/katex.min.css';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import 'prosemirror-tables/style/tables.css';

render(<App />, document.getElementById('app')!);

// Errors that escape (a node view, a promise nobody awaited) must not vanish in the console: show
// them. The same message is shown at most once per 5 s.
{
  let last = '', lastAt = 0;
  const sent = new Set<string>();
  const report = (msg: string, stack?: string) => {
    const now = Date.now();
    if (msg === last && now - lastAt < 5000) return;
    last = msg; lastAt = now;
    editorContext.notify?.('Something went wrong: ' + msg.slice(0, 200) + ' (details in the browser console)', 'error');
    editorContext.lastError = msg + (stack ? '\n' + stack : '');
    // ...and reach the developers: an issue per distinct message (deduplicated on the server; no
    // document content, see server/src/feedback.ts). At most a few per page load.
    if (sent.size < 5 && !sent.has(msg) && !/Failed to fetch|NetworkError|Load failed/.test(msg)) {
      sent.add(msg);
      api.clientError({ message: msg, stack: stack?.slice(0, 4000) ?? null }).catch(() => {});
    }
  };
  window.addEventListener('error', e => { if (e.message) report(e.message, e.error instanceof Error ? e.error.stack : undefined); });
  window.addEventListener('unhandledrejection', e => { const r = e.reason; report(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined); });
}

// offline app shell (production builds only; see src/sw.js)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // Requests made before the worker controls the page are not in its cache: once it does, fetch the
  // responses needed to start offline (who am I, project list, metadata of the open document).
  const warm = () => {
    const urls = ['/api/auth/me', '/api/projects'];
    const id = decodeURIComponent(location.hash.replace(/^#\/?/, '').split('?')[0]);
    if (id) urls.push(`/api/docs/${encodeURIComponent(id)}/meta`);
    for (const u of urls) fetch(u, { credentials: 'same-origin' }).catch(() => {});
  };
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('service worker registration failed', e));
    if (navigator.serviceWorker.controller) warm();
    else navigator.serviceWorker.addEventListener('controllerchange', warm, { once: true });
  });
}
