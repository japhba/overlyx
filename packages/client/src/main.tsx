import { render } from 'preact';
import { App } from './app/App';
import './styles.css';
import 'katex/dist/katex.min.css';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import 'prosemirror-tables/style/tables.css';

render(<App />, document.getElementById('app')!);

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
