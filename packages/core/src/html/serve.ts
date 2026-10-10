/**
 * Serving an HTML deliverable's folder to a sandboxed frame — shared by the server (deliverables.ts)
 * and the VS Code extension's local server (host/deliverables.ts): where a request's path leads in
 * the project, the sandbox policy, and the OverLyX runtime put first into a page's <head>.
 */

/** the frame's policy: scripts run, but in an opaque origin (no cookies, storage or same-origin requests of the host) */
export const SANDBOX_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';

/** The modes of the runtime: the editor's frame, its slide rail, a presentation, a print (PDF), a check (render_page), a plain view. */
export const RUNTIME_MODES = ['edit', 'thumb', 'present', 'print', 'check', 'view'] as const;
export type RuntimeMode = typeof RUNTIME_MODES[number];

/** the runtime's tags, first thing in <head> (`src`: where runtime.js is served) */
export function runtimeTags(mode: RuntimeMode, extra: Record<string, unknown> = {}, src = '/_ol/runtime.js'): string {
  const cfg = JSON.stringify({ mode, ...extra }).replace(/</g, '\\u003c');
  return `<meta name="referrer" content="no-referrer" data-ol-runtime><script data-ol-runtime>window.__OL=${cfg}</script><script data-ol-runtime src="${src.replace(/"/g, '&quot;')}"></script>`;
}

/** `html` with `tags` at the top of its <head> (made when it has none) */
export function injectRuntime(html: string, tags: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length);
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${tags}</head>` + html.slice(htmlTag.index + htmlTag[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + `<head>${tags}</head>` + html.slice(at);
}

const normalize = (p: string): string => {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length || out[out.length - 1] === '..') out.push('..'); else out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
};

/** a project-relative path for `rest` (relative to the folder `dir`), or null when it leaves the project or reaches .git */
export function resolveInProject(dir: string, rest: string): string | null {
  if (rest.includes('\0') || rest.includes('\\')) return null;
  if (rest.startsWith('/')) return null;
  const rel = normalize((dir ? dir + '/' : '') + rest);
  if (rel === '..' || rel.startsWith('../')) return null;
  if (rel.split('/').some(seg => seg === '.git' || seg.startsWith('.overlyx'))) return null;
  return rel;
}
