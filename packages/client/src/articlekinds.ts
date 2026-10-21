/**
 * Which .html files of the projects are articles (core html/article.ts: written in the document
 * editor) and which are deliverables (decks, posters, pages: the canvas). Only the file says — its
 * `<meta name="overlyx">` — so the projects' file lists tell (server projectfiles.ts: an article is
 * kind 'doc', format 'article'); what they said is kept in this browser, so a page opened from a
 * link goes to the right editor at once next time.
 */
const KEY = 'ol.articleKinds';
const MAX = 600;

/** id → is an article */
const kinds = new Map<string, boolean>(load());
let unsure = false;
const listeners = new Set<() => void>();

function load(): [string, boolean][] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((e): e is [string, boolean] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'boolean') : [];
  } catch { return []; }
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify([...kinds].slice(-MAX))); } catch { /* private mode: the lists tell again */ }
}

const isHtml = (path: string) => /\.html?$/i.test(path);

/** What the projects' file lists say about their .html files. */
export function noteProjectFiles(projects: readonly { name: string; files?: readonly { path: string; kind: string; format?: string }[] }[]): void {
  let changed = false;
  for (const p of projects) {
    for (const f of p.files ?? []) {
      if (!isHtml(f.path)) continue;
      const id = `${p.name}/${f.path}`, article = f.kind === 'doc' && f.format === 'article';
      if (kinds.get(id) === article) continue;
      kinds.delete(id);
      kinds.set(id, article);
      changed = true;
    }
  }
  if (changed) save();
  if (changed || unsure) { unsure = false; for (const l of listeners) l(); }
}

/** One file's kind, known for certain (a new article was just made, a page found to be one). */
export function noteArticle(id: string, article: boolean): void {
  if (kinds.get(id) === article) return;
  kinds.delete(id);
  kinds.set(id, article);
  save();
  for (const l of listeners) l();
}

/** Is this document (id) an HTML article? */
export function isArticleDoc(id: string | null | undefined): boolean {
  return !!id && isHtml(id) && kinds.get(id) === true;
}

/** Is it known which editor an .html file opens in? (Not yet: wait for the project's file list.) */
export function htmlKindKnown(id: string): boolean {
  return !isHtml(id) || kinds.has(id) || unsure;
}

/** The file lists could not be had (offline): an .html file nobody said is an article opens on the canvas. */
export function htmlKindsUnsure(): void {
  if (unsure) return;
  unsure = true;
  for (const l of listeners) l();
}

export function onArticleKinds(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
