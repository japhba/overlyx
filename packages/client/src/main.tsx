import './app/theme';   // sets data-theme on <html> before anything renders
import './app/uimode';  // and data-ui (Classic / Modern)
import { render } from 'preact';
import { App } from './app/App';
import { editorContext } from './editor/context';
import { api } from './api';
import { isBenignBrowserError } from './error-reporting';
import { initUsage, recordUsage, noticeTemplate } from './usage';
import { currentMathFont, onMathRendererChange } from './editor/lyxmath/mathjax';
import './styles.css';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import 'prosemirror-tables/style/tables.css';

render(<App />, document.getElementById('app')!);
initUsage();   // anonymous usage statistics (usage.ts): the session, screen changes, flushing on leave

// Errors that escape (a node view, a promise nobody awaited) must not vanish in the console: show
// them. The same message is shown at most once per 5 s.
{
  let last = '', lastAt = 0;
  const sent = new Set<string>();
  const report = (msg: string, stack?: string) => {
    // Browsers deliver this ResizeObserver scheduling notice as a global ErrorEvent even though
    // no application exception occurred. It is safe to leave in the console, but not to alarm
    // the user or record an automatic error report for it.
    if (isBenignBrowserError(msg)) return;
    // a request the network (or leaving the page) cut off — every browser words it differently, Safari
    // as "… due to access control checks": no application error, and offline the app goes on by itself
    if (/Failed to fetch|NetworkError|Load failed|access control checks|network connection was lost/i.test(msg)) return;
    const now = Date.now();
    if (msg === last && now - lastAt < 5000) return;
    last = msg; lastAt = now;
    editorContext.notify?.('Something went wrong: ' + msg.slice(0, 200) + ' (details in the browser console)', 'error');
    editorContext.lastError = msg + (stack ? '\n' + stack : '');
    recordUsage('error', noticeTemplate(msg));
    // ...and reach the developers: one report per distinct message, kept on the server (deduplicated
    // there; no document content, see server/src/feedback.ts). At most a few per page load.
    if (sent.size < 5 && !sent.has(msg)) {
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
    // (the document's id without the hash's view prefix — raw:, text:, pdf: asked for a document that
    // does not exist, a 403 in the console and nothing cached; a share link names no document)
    let id = '';
    try { id = decodeURIComponent(location.hash.replace(/^#\/?/, '').split('?')[0]).replace(/^(raw|text|pdf):/, ''); } catch { /* malformed */ }
    if (id && !id.startsWith('share/') && id.includes('/')) urls.push(`/api/docs/${encodeURIComponent(id)}/meta`);
    for (const u of urls) fetch(u, { credentials: 'same-origin' }).catch(() => {});
  };
  // the math font in use is cached whole (sw.js 'math-font'), by the worker that controls the page — a new one after a deployment starts with an empty cache
  const cacheMathFont = () => navigator.serviceWorker.controller?.postMessage({ type: 'math-font', font: currentMathFont() });
  onMathRendererChange(cacheMathFont);
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('service worker registration failed', e));
    if (navigator.serviceWorker.controller) { warm(); cacheMathFont(); }
    else navigator.serviceWorker.addEventListener('controllerchange', warm, { once: true });
    navigator.serviceWorker.addEventListener('controllerchange', cacheMathFont);
  });
}
