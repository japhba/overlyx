/**
 * My library on the client: the account's references (server library.ts), fetched once and shared
 * by the Library page and pane, the citation dialog and the citation hover card. Where the server has
 * no library (the VS Code extension's local bridge, a guest), `available` is false and those places
 * leave it out.
 */
import { useEffect, useState } from 'preact/hooks';
import { API_BASE } from '../api';
import type { LitHit } from '../api';

export interface LibRef {
  id: number; key: string; type: string; title: string; authors: string[]; venue: string; year: number | null;
  doi: string | null; arxiv: string | null; url: string | null; tags: string[]; note: string; pdf: boolean; pdfSize: number | null;
  source: string; added: number; updated: number; abstract?: string; bibtex?: string;
}
export interface AddOutcome { added: LibRef[]; duplicates: LibRef[]; failed: string[] }
export interface LibraryState {
  available: boolean; loaded: boolean; refs: LibRef[]; tags: { name: string; count: number }[];
  pdfBytes: number; pdfMax: number; zotero: boolean; lookups: boolean; error?: string;
}

async function call<T>(method: string, url: string, body?: unknown, raw?: Blob, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(API_BASE + url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : raw ? { 'content-type': raw.type || 'application/pdf', ...headers } : headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status} ${res.statusText}`), { status: res.status });
  return data as T;
}

export const libraryApi = {
  list: () => call<Omit<LibraryState, 'available' | 'loaded'>>('GET', '/api/library'),
  get: (id: number) => call<LibRef>('GET', `/api/library/${id}`),
  lookup: (q: string) => call<{ hits: LitHit[]; warnings: string[] }>('GET', `/api/library/lookup?q=${encodeURIComponent(q)}`),
  addHit: (hit: LitHit) => call<AddOutcome>('POST', '/api/library', { hit }),
  addText: (text: string, source?: 'file') => call<AddOutcome>('POST', '/api/library', { text, source }),
  importZotero: () => call<AddOutcome>('POST', '/api/library/zotero', {}),
  addPdf: (file: File) => call<{ ref: LibRef; duplicate: boolean; found: string | null }>('POST', '/api/library/pdf', undefined, file, { 'x-file-name': encodeURIComponent(file.name) }),
  edit: (id: number, patch: Record<string, unknown>) => call<LibRef>('PATCH', `/api/library/${id}`, patch),
  remove: (id: number) => call<{ ok: boolean }>('DELETE', `/api/library/${id}`),
  attachPdf: (id: number, file: Blob) => call<LibRef>('PUT', `/api/library/${id}/pdf`, undefined, file),
  removePdf: (id: number) => call<LibRef>('DELETE', `/api/library/${id}/pdf`),
  pdfUrl: (id: number) => `${API_BASE}/api/library/${id}/pdf`,
  exportUrl: () => `${API_BASE}/api/library/export.bib`,
};

let state: LibraryState = { available: false, loaded: false, refs: [], tags: [], pdfBytes: 0, pdfMax: 0, zotero: false, lookups: false };
const listeners = new Set<(s: LibraryState) => void>();
let inflight: Promise<LibraryState> | null = null;

function set(s: LibraryState): void { state = s; for (const f of listeners) f(s); }

/** (Re)load the library from the server. */
export function refreshLibrary(): Promise<LibraryState> {
  inflight ??= libraryApi.list()
    .then(r => { set({ ...r, available: true, loaded: true }); return state; })
    .catch((e: Error & { status?: number }) => { set({ ...state, available: false, loaded: true, error: e.message }); return state; })
    .finally(() => { inflight = null; });
  return inflight;
}

export function libraryState(): LibraryState { return state; }

/** the library, loaded on first use */
export function useLibrary(): LibraryState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    if (!state.loaded) void refreshLibrary(); else setS(state);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

/** a reference changed or came: into the list without a reload */
export function putRef(r: LibRef): void {
  const i = state.refs.findIndex(x => x.id === r.id);
  const { abstract: _a, bibtex: _b, ...slim } = r;
  const refs = i >= 0 ? state.refs.map(x => (x.id === r.id ? { ...x, ...slim } : x)) : [slim, ...state.refs];
  set({ ...state, refs, tags: tagCounts(refs) });
}
export function dropRef(id: number): void {
  const refs = state.refs.filter(x => x.id !== id);
  set({ ...state, refs, tags: tagCounts(refs) });
}
function tagCounts(refs: LibRef[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of refs) for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
}

/* ------------------------------------------------------------------ search, names */

const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** every word of the query in the title, an author, the venue, the year, the key, a tag, the DOI or the note */
export function matchRef(r: LibRef, q: string): boolean {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = norm([r.title, r.authors.join(' '), r.venue, r.year ?? '', r.key, r.tags.join(' '), r.doi ?? '', r.arxiv ?? '', r.note].join(' '));
  return words.every(w => hay.includes(w));
}
export const normTitle = (s: string) => norm(s).replace(/[^a-z0-9]+/g, ' ').trim();

/** "Vaswani et al." / "Vaswani and Shazeer" */
export function authorsShort(a: string[]): string {
  const last = (n: string) => n.trim().split(/\s+/).pop() ?? n;
  if (!a.length) return '';
  if (a.length === 1) return last(a[0]);
  if (a.length === 2) return `${last(a[0])} and ${last(a[1])}`;
  return `${last(a[0])} et al.`;
}
export function authorsLine(a: string[], max = 4): string {
  return a.length > max ? a.slice(0, max - 1).join(', ') + ' et al.' : a.join(', ');
}

/** the library's reference for a citation key of a document: same key, else the same title */
export function refForCitation(key: string, title?: string): LibRef | undefined {
  return state.refs.find(r => r.key === key) ?? (title ? state.refs.find(r => normTitle(r.title) === normTitle(title)) : undefined);
}

/* ------------------------------------------------------------------ the full page */

let pageOpen = false;
const pageListeners = new Set<(open: boolean) => void>();
/** show (or hide) the Library page over the app */
export function openLibrary(open = true): void { pageOpen = open; for (const f of pageListeners) f(open); }
export function useLibraryPageOpen(): boolean {
  const [o, setO] = useState(pageOpen);
  useEffect(() => { pageListeners.add(setO); setO(pageOpen); return () => { pageListeners.delete(setO); }; }, []);
  return o;
}
