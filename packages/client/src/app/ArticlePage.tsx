/**
 * An HTML article's right-hand pane (core html/article.ts): where a LaTeX document has its PDF, the
 * page as it is published — its own styles, scripts and fonts, running in the sandbox (server
 * deliverables.ts, runtime "view" mode) — loaded again a moment after each save, where it was
 * scrolled to (runtime/embed.ts startViewSync). A phone's width on request; the PDF is the page
 * printed by the server's browser. What the page keeps in its localStorage (a view option it offers)
 * is kept here for each project, as a browser keeps it for a site, and handed back at each load
 * (runtime/storage.ts). The page follows the editor's cursor: the paragraph it is in is brought into
 * view when the cursor moves to another (runtime/follow.ts), and marked on Sync (Ctrl+Alt+J). The
 * ruler over it (View ▸ Ruler, as over the editor) sets how wide its text runs here: a setting of this
 * browser like the editor's text width, the page itself as it is (runtime/column.ts).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { api } from '../api';
import { projectOfDoc, docPathOf } from '@overlyx/core';
import { openProjectPath } from '../openpath';
import { PAGE_STORAGE_NAME, PAGE_STORAGE_MAX } from '../deliverable/runtime/storage';
import { followWords, type FollowTarget } from '../deliverable/runtime/follow';
import { Ruler, MAX_WIDTH } from './Ruler';

const PHONE = 390;
const storeKey = (project: string) => 'ol.pageStorage:' + project;
/** how wide the page's text runs in the pane (px; 0: as wide as the pane lets it; none kept: as the page has it) */
const WIDTH_KEY = 'ol.pageWidth';
function storedWidth(): number | null {
  try {
    const v = localStorage.getItem(WIDTH_KEY);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 && n <= MAX_WIDTH ? n : null;
  } catch { return null; }
}
/** the page's text column as its frame reports it (px of the frame) */
interface Column { left: number; width: number; own: number; full: number }

/** where the editor's cursor is, for the page to find: its paragraph's own words (a paragraph
 *  without any, such as a display formula's: the one before it, else after) */
function cursorTarget(view: EditorView): FollowTarget | null {
  const blocks: { pos: number; size: number; words: string[] }[] = [];
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    node.forEach(c => { text += c.isText ? c.text ?? '' : ' '; });
    blocks.push({ pos, size: node.content.size, words: followWords(text) });
    return true;
  });
  const { from, $from } = view.state.selection;
  let d = $from.depth;
  while (d > 0 && !$from.node(d).isTextblock) d--;
  let i = d > 0 ? blocks.findIndex(b => b.pos === $from.before(d)) : blocks.findIndex(b => b.pos >= from);
  if (i < 0) return null;
  let frac = Math.min(1, Math.max(0, (from - blocks[i].pos - 1) / Math.max(1, blocks[i].size)));
  if (!blocks[i].words.length) {
    let j = i;
    while (j >= 0 && !blocks[j].words.length) j--;
    if (j >= 0) frac = 1;
    else { j = i; while (j < blocks.length && !blocks[j].words.length) j++; frac = 0; }
    if (j < 0 || j >= blocks.length) return null;
    i = j;
  }
  const key = blocks[i].words.join(' ');
  const nth = blocks.slice(0, i).filter(b => b.words.join(' ') === key).length;
  return { words: blocks[i].words, nth, frac };
}

export function ArticlePage({ docId, savedAt, view, selTick, syncSeq, ruler, onClose }: {
  docId: string;
  /** when the document was last written: the page is loaded again after it */
  savedAt: number;
  /** the article's editor, and a count of its cursor's moves: the page follows the cursor */
  view?: EditorView | null;
  selTick?: number;
  /** Sync (Ctrl+Alt+J): the cursor's paragraph shown and marked */
  syncSeq?: number;
  /** View ▸ Ruler: the ruler over the page */
  ruler?: boolean;
  onClose?: () => void;
}) {
  const project = projectOfDoc(docId), path = docPathOf(docId);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState(false);
  const [n, setN] = useState(0);
  const [width, setWidth] = useState<number | null>(storedWidth);
  const [column, setColumn] = useState<Column | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const scrolled = useRef(0);
  const stored = useRef<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  /** the page has loaded (the frame takes messages); a Sync waiting for it; the place last sent */
  const ready = useRef(false);
  const pendingSync = useRef<FollowTarget | null>(null);
  const pendingFollow = useRef<FollowTarget | null>(null);
  const followed = useRef('');
  const sendFollow = (target: FollowTarget) => frame.current?.contentWindow?.postMessage({ ol: 'viewFollow', target }, '*');
  /** the text width for the page (at a phone's width: the page's own) */
  const widthNow = useRef<number | null>(null);
  widthNow.current = phone ? null : width;
  const sendWidth = () => frame.current?.contentWindow?.postMessage({ ol: 'viewWidth', width: widthNow.current }, '*');
  if (stored.current === null) { try { stored.current = localStorage.getItem(storeKey(project)) ?? ''; } catch { stored.current = ''; } }

  useEffect(() => {
    let live = true;
    api.deliverableLink(project, path)
      .then(l => { if (live) setUrl(l.base + l.entry.split('/').map(encodeURIComponent).join('/')); })
      .catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [project, path]);

  // the page saved anew: shown anew, a moment later (the next save may follow right away)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => setN(x => x + 1), 900);
    return () => clearTimeout(t);
  }, [savedAt]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { ol?: string; y?: number } | null;
      if (d?.ol === 'viewScroll' && typeof d.y === 'number') scrolled.current = d.y;
      // the page's localStorage changed: given back when the page is loaded again
      const items = (d as { items?: unknown }).items;
      if (d?.ol === 'pageStorage' && items && typeof items === 'object') {
        const json = JSON.stringify(Object.fromEntries(Object.entries(items).filter(([, v]) => typeof v === 'string')));
        if (json.length <= PAGE_STORAGE_MAX) {
          stored.current = json === '{}' ? '' : json;
          try { if (stored.current) localStorage.setItem(storeKey(project), stored.current); else localStorage.removeItem(storeKey(project)); } catch { /* ignore */ }
        }
      }
      // a link of the page to another file of the project: opened in OverLyX (one leaving OverLyX opens a tab itself, runtime/links.ts)
      if (d?.ol === 'openPath' && typeof (d as { path?: unknown }).path === 'string') openProjectPath(project, (d as { path: string }).path);
      // where the page's text column is, for the ruler (runtime/column.ts)
      if (d?.ol === 'viewColumn') {
        const c = d as Partial<Column> & { none?: boolean };
        setColumn(c.none || ![c.left, c.width, c.own, c.full].every(v => typeof v === 'number' && Number.isFinite(v)) ? null : { left: c.left!, width: c.width!, own: c.own!, full: c.full! });
      }
      // (loaded: back where the reader was, else at the cursor; a Sync asked for meanwhile shown)
      if (d?.ol === 'viewReady') {
        ready.current = true;
        sendWidth();
        if (scrolled.current) frame.current.contentWindow?.postMessage({ ol: 'viewScrollTo', y: scrolled.current }, '*');
        const v = viewRef.current;
        const t = pendingSync.current ?? pendingFollow.current ?? (!scrolled.current && v ? cursorTarget(v) : null);
        pendingSync.current = pendingFollow.current = null;
        if (t) sendFollow(t);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [project]);

  // (the page loads with the width set then, so it shows at that width; later changes go to it as messages)
  const loadWidth = useMemo(() => widthNow.current, [url, n]);
  const src = url ? `${url}?ol=view&n=${n}${loadWidth !== null ? '&w=' + loadWidth : ''}` : null;
  useEffect(() => { ready.current = false; }, [src]);

  useEffect(() => {
    try { if (width === null) localStorage.removeItem(WIDTH_KEY); else localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* ignore */ }
  }, [width]);
  useEffect(() => { if (ready.current) sendWidth(); }, [width, phone]);

  // the cursor moved to another paragraph (or far within one): the page brings it into view
  useEffect(() => {
    if (!view) return;
    const t = setTimeout(() => {
      const target = cursorTarget(view);
      if (!target) return;
      const key = `${target.words.join(' ')}|${target.nth}|${Math.round(target.frac * 4)}`;
      if (key === followed.current) return;
      followed.current = key;
      if (ready.current) sendFollow(target); else pendingFollow.current = target;
    }, 250);
    return () => clearTimeout(t);
  }, [view, selTick]);

  // Sync: shown and marked, once the page is there
  useEffect(() => {
    if (!syncSeq || !view) return;
    const target = cursorTarget(view);
    if (!target) return;
    if (ready.current) sendFollow({ ...target, flash: true }); else pendingSync.current = { ...target, flash: true };
  }, [syncSeq]);

  const pdfHref = `/api/projects/${encodeURIComponent(project)}/deliverable-pdf?path=${encodeURIComponent(path)}`;
  return (
    <div class="pdf-panel article-page" data-article-page>
      <div class="bar">
        <button type="button" class="small-btn" onClick={() => setN(x => x + 1)} title="Load the page again">↻</button>
        <button type="button" class={'small-btn' + (phone ? ' active' : '')} aria-pressed={phone} onClick={() => setPhone(p => !p)} title="The page at a phone's width">Phone</button>
        <div class="pdf-bar-fill" />
        {src && <a class="small-btn" href={`${url}?ol=view`} target="_blank" rel="noopener" title="The page in a tab of its own">Open ↗</a>}
        <a class="small-btn" href={pdfHref} target="_blank" rel="noopener" title="The page printed as a PDF">PDF</a>
        {onClose && <button type="button" class="small-btn close" onClick={onClose} title="Hide the page">✕</button>}
      </div>
      {ruler && !phone && src && column && (
        <Ruler width={width ?? Math.round(column.width)} onChange={setWidth}
          page={{ left: column.left, width: column.width, full: column.full, own: column.own, onOwn: () => setWidth(null) }} />
      )}
      <div class={'article-page-view' + (phone ? ' phone' : '')}>
        {src ? <iframe ref={frame} key={src} src={src} style={phone ? { width: PHONE + 'px' } : undefined} title="The page as published"
          name={stored.current ? PAGE_STORAGE_NAME + stored.current : undefined}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads" />
          : <div class="pdf-empty">{error ? 'Could not show the page: ' + error : 'Loading the page…'}</div>}
      </div>
    </div>
  );
}
