/**
 * A file of a project opened from a link in it (an article's link, a page shown beside one, a running
 * HTML block): a document, a page, a deck or a PDF in OverLyX; any other file in a new tab. Links that
 * leave OverLyX never come here: they open in a new tab.
 */
import { fileUrl, isTextFile } from './api';

/** where the host opens a project's files instead (VS Code: in its editors) */
let hostOpen: ((project: string, path: string) => void) | null = null;
export function setProjectPathOpener(open: ((project: string, path: string) => void) | null): void { hostOpen = open; }

/** `rel` (a path in the project, with a `#place` perhaps) opened: in OverLyX when it is something OverLyX edits or shows */
export function openProjectPath(project: string, rel: string): void {
  const path = rel.replace(/[?#].*$/, '').replace(/^\/+/, '');
  if (!path) return;
  if (hostOpen) { hostOpen(project, path); return; }
  if (/\.(html?|tex|md|markdown|board)$/i.test(path)) location.hash = '#/' + project + '/' + path;
  else if (/\.pdf$/i.test(path)) location.hash = '#/pdf:' + project + '/' + path;
  else if (!/\.lyx$/i.test(path) && isTextFile(path)) location.hash = '#/text:' + project + '/' + path;
  else window.open(fileUrl(project, path), '_blank', 'noopener');
}

/** A link of a document relative to it (`../talk/index.html`, `figures/a.png`) as a path in its project; null when it leaves the project. */
export function resolveInDocument(docId: string, target: string): { project: string; path: string } | null {
  const slash = docId.indexOf('/', docId.indexOf('/') + 1);
  const project = docId.slice(0, slash), docPath = docId.slice(slash + 1);
  const parts = target.startsWith('/') ? [] : docPath.split('/').slice(0, -1);
  for (const seg of target.replace(/[?#].*$/, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(decodeURIComponent(seg));
  }
  return parts.length ? { project, path: parts.join('/') } : null;
}
