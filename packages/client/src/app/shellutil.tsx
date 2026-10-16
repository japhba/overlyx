/**
 * Helpers of the editor shells — the web client's Workspace (App.tsx) and the VS Code webview's
 * EditorShell (packages/vscode) — that are about the document rather than the surrounding UI:
 * author colours and ids for change tracking, the document language, label suggestions, the
 * paragraph layout picker, word counts. One copy for both shells (tests/parity.test.ts).
 */
import { hostedZoomPill } from './zoomhud';
import { DetentPinch, stepOnto, type Detent } from './zoomdetent';
import { useEffect, useRef, useState } from 'preact/hooks';
import { styleLabel, styleSearchText } from './stylenames';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { currentParagraph } from '../editor/commands';
import { editorContext, onMetaChange } from '../editor/context';
import { recordInteraction } from '../usage';

/**
 * Zoom the rendered text with a font-size variable, remembered per browser. The column, ruler
 * and graphics keep their sizes; the text reflows within the column.
 * Both shells use this — never CSS `zoom` on a container,
 * which puts mouse coordinates and the layout into different scales in Chromium (hit tests miss,
 * drags jump, selections and their highlights disagree).
 */
export function applyEditorZoom(zoom: number): void {
  document.documentElement.style.setProperty('--editor-zoom', String(zoom));
  try { localStorage.setItem('ol.zoom', String(zoom)); } catch { /* storage unavailable */ }
  // a change (not the zoom a document opens with): said over the text for a moment, as every zoom is (zoomhud.ts)
  if (textZoomShown !== null && textZoomShown !== zoom) { textZoomPill.show(zoom); recordInteraction('zoom', 'changed', { target: 'text' }); }
  textZoomShown = zoom;
}
let textZoomShown: number | null = null;
const textZoomPill = hostedZoomPill(() => document.querySelector<HTMLElement>('.editor-scroll'), 'data-text-zoomhud');

/** how far the text zooms (the status bar's, Ctrl + / −'s, a pinch's) */
export const TEXT_ZOOM_MIN = 0.5, TEXT_ZOOM_MAX = 2.5;
/** the text's own size: a level a pinch stops at and holds, and a step does not pass (zoomdetent.ts) */
const TEXT_LEVELS: Detent<'own'>[] = [{ key: 'own', z: 1, hold: Math.log(1.25) }];

/** the text zoom a step from `z` goes to (Ctrl + / −, the status bar's − / +: `d` ±1; 0: 100 %): 10 % on, not past 100 % */
export function stepTextZoom(z: number, d: number): number {
  if (d === 0) return 1;
  const to = stepOnto(z, (z + d * 0.1) / z, TEXT_LEVELS).z;
  return Math.max(TEXT_ZOOM_MIN, Math.min(TEXT_ZOOM_MAX, +to.toFixed(2)));
}

/** the scroller of the document text under `t`, if a pinch there zooms the text (a layout document's canvas zooms itself) */
function textScroller(t: EventTarget | null): HTMLElement | null {
  const el = t instanceof Element ? t : null;
  const sc = el?.closest<HTMLElement>('.editor-scroll');
  const ed = sc?.querySelector('.lyx-editor');
  return sc && ed && !ed.classList.contains('ol-layout') ? sc : null;
}

/**
 * What a zoom keeps where it is: the character under the screen point (x, y) — its middle's screen y,
 * read again once the text has reflowed — and how far from the point it was.
 */
function textAnchor(x: number, y: number): { mid: () => number | null; off: number } | null {
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null; caretRangeFromPoint?(x: number, y: number): Range | null };
  const pos = d.caretPositionFromPoint?.(x, y);
  const r = pos ? { node: pos.offsetNode, at: pos.offset } : (() => { const q = d.caretRangeFromPoint?.(x, y); return q ? { node: q.startContainer, at: q.startOffset } : null; })();
  if (!r) return null;
  const mid = (): number | null => {
    if (!r.node.isConnected) return null;
    let box: DOMRect | undefined;
    const len = r.node.nodeType === Node.TEXT_NODE ? r.node.textContent?.length ?? 0 : 0;
    if (len) {
      // (a character's box: a collapsed range has none at a line's start in some browsers)
      const q = document.createRange(), i = Math.min(r.at, len - 1);
      q.setStart(r.node, i); q.setEnd(r.node, i + 1);
      box = q.getClientRects()[0] ?? q.getBoundingClientRect();
    } else box = (r.node instanceof Element ? r.node : r.node.parentElement)?.getBoundingClientRect();
    return box && (box.width || box.height) ? box.top + box.height / 2 : null;
  };
  const m = mid();
  return m === null ? null : { mid, off: m - y };
}

/**
 * Two fingers on a touch screen zoom the document text (their middle pans as it moves; one finger
 * scrolls as ever). The line under the fingers stays under them while the text reflows. It stops at
 * the text's own size (100 %) and holds there till pinched well past it (zoomdetent.ts), giving a
 * little meanwhile and settling back once let go; let go near it, it settles on it. Said over the
 * text as it goes (the pill). Both shells (App, VS Code's EditorShell): `zoom` and `setZoom` are their text zoom.
 * Unhandled trackpad pinches are swallowed so they cannot magnify the whole interface instead.
 */
export function useTextPinch(zoom: number, setZoom: (z: number) => void): void {
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const setRef = useRef(setZoom); setRef.current = setZoom;
  useEffect(() => {
    /** the zoom shown now, ahead of the shell's while a touch pinch goes on (`--editor-zoom`) */
    const shown = () => parseFloat(document.documentElement.style.getPropertyValue('--editor-zoom')) || zoomRef.current;
    /** show zoom `z` (the text reflows), the anchor's character back at (its offset from) the screen y `y`; `held`: said as 100 % */
    const show = (sc: HTMLElement, a: ReturnType<typeof textAnchor>, z0: number, z: number, y: number, held: boolean) => {
      document.documentElement.style.setProperty('--editor-zoom', String(z));
      textZoomPill.show(held ? 1 : z);
      textZoomShown = z;
      const m = a?.mid();
      if (a && m !== null && m !== undefined) sc.scrollTop += m - (y + a.off * (z / z0));
    };
    const commit = (z: number) => { const v = Math.abs(z - 1) < 0.005 ? 1 : +z.toFixed(2); if (v !== zoomRef.current) recordInteraction('zoom', 'changed', { target: 'text' }); textZoomShown = v; setRef.current(v); };

    let g: { sc: HTMLElement; p: DetentPinch<'own'>; a: ReturnType<typeof textAnchor>; z0: number; z: number; held: boolean; x: number; y: number } | null = null;
    let raf = 0, settling = 0;
    const draw = () => { raf = 0; if (g) show(g.sc, g.a, g.z0, g.z, g.y, g.held); };
    const begin = (sc: HTMLElement, x: number, y: number) => {
      cancelAnimationFrame(settling); settling = 0;
      const z0 = shown();
      g = { sc, p: new DetentPinch<'own'>(Math.abs(z0 - 1) < 0.005 ? 'own' : z0, z0, [TEXT_ZOOM_MIN, TEXT_ZOOM_MAX]), a: textAnchor(x, y), z0, z: z0, held: false, x, y };
    };
    const by = (d: number, x: number, y: number) => {
      if (!g) return;
      const sh = g.p.by(d, TEXT_LEVELS);
      g.held = typeof sh.zoom === 'string';
      g.z = typeof sh.zoom === 'string' ? sh.stretch : sh.zoom;
      g.x = x; g.y = y;
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const end = () => {
      const p = g;
      g = null;
      if (!p) return;
      cancelAnimationFrame(raf); raf = 0;
      const e = p.p.end(TEXT_LEVELS);
      if (!e) { show(p.sc, p.a, p.z0, p.z, p.y, false); commit(p.z); return; }
      // onto 100 % on a short spring
      const t0 = performance.now();
      const frame = () => {
        const t = Math.min(1, (performance.now() - t0) / 200), k = 1 - (1 - t) ** 3;
        show(p.sc, p.a, p.z0, e.from + (1 - e.from) * k, p.y, true);
        if (t < 1) { settling = requestAnimationFrame(frame); return; }
        settling = 0;
        commit(1);
      };
      frame();
    };
    let touch: { d: number; x: number; y: number } | null = null;
    const two = (t: TouchList) => ({ d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const onTouch = (e: TouchEvent) => {
      if (e.type === 'touchstart') {
        if (e.touches.length !== 2 || touch) return;
        const sc = textScroller(e.target);
        if (!sc) return;
        e.preventDefault();
        touch = two(e.touches);
        begin(sc, touch.x, touch.y);
        return;
      }
      if (!touch) return;
      if (e.type === 'touchmove') {
        if (e.touches.length < 2 || !g) return;
        e.preventDefault();
        const now = two(e.touches);
        g.sc.scrollTop -= now.y - touch.y;
        g.sc.scrollLeft -= now.x - touch.x;
        if (now.d > 0 && touch.d > 0) by(Math.log(now.d / touch.d), now.x, now.y);
        touch = now;
        return;
      }
      if (e.touches.length < 2) { touch = null; end(); }
    };
    const opts = { passive: false } as AddEventListenerOptions;
    // Trackpad pinches must not fall through to Chrome's zoom of the whole app. Cancel only the
    // browser action: PDF/canvas handlers run first, ordinary scrolling passes through, and the
    // document zoom buttons/keys still work.
    const onWheel = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
    const onGesture = (e: Event) => e.preventDefault();
    window.addEventListener('wheel', onWheel, opts);
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) window.addEventListener(t, onGesture, opts);
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.addEventListener(t, onTouch as EventListener, opts);
    return () => {
      window.removeEventListener('wheel', onWheel);
      for (const t of ['gesturestart', 'gesturechange', 'gestureend']) window.removeEventListener(t, onGesture);
      for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.removeEventListener(t, onTouch as EventListener);
      cancelAnimationFrame(raf); cancelAnimationFrame(settling);
    };
  }, []);
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T & { cancel(): void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  return Object.assign(((...a: any[]) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T, { cancel() { if (t) clearTimeout(t); } });
}

/** LyX's author id for a name: FNV-1a over the name, so the same person gets the same id in every document. */
export function hashAuthor(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h | 0;
}

/** One colour per LyX author for change tracking (stable across sessions: by author id order). */
export function applyAuthorColors(authors: { id: number; name: string }[]): void {
  const palette = ['#2e7d32', '#c62828', '#1565c0', '#6a1b9a', '#ef6c00', '#00838f', '#ad1457', '#4e342e', '#558b2f', '#283593'];
  // the same hues, lifted so that they read on the dark page (app/theme.ts)
  const dark = ['#7bd88f', '#ff8a80', '#82b1ff', '#d6a2ff', '#ffb74d', '#4dd0e1', '#f48fb1', '#d7ccc8', '#c5e1a5', '#9fa8da'];
  let el = document.getElementById('ol-author-colors') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'ol-author-colors'; document.head.appendChild(el); }
  // an agent's tracked changes (the MCP connector's authors, "… (MCP)") are grey by default,
  // so the colours stay for human co-authors and the eye can skim the machine's insertions
  const isAgent = (n: string) => /\(MCP\)\s*$/.test(n);
  el.textContent = authors.map((a, i) => {
    const light = isAgent(a.name) ? '#757575' : palette[i % palette.length];
    const dk = isAgent(a.name) ? '#9e9e9e' : dark[i % dark.length];
    return `.lyx-change[data-author="${a.id}"], .lyx-inset[data-author="${a.id}"] { --change-color: ${light}; }\n`
      // (lifted only on a dark page: with smart invert off the page is white paper, app/darkpages.ts)
      + `html[data-theme="dark"][data-dark-pages] .lyx-change[data-author="${a.id}"], html[data-theme="dark"][data-dark-pages] .lyx-inset[data-author="${a.id}"] { --change-color: ${dk}; }`;
  }).join('\n');
}

// the colours follow the metadata: an author who starts tracking changes (or an agent whose edits arrive
// live) gets a colour without a reload
onMetaChange(() => { const m = editorContext.meta; if (m) applyAuthorColors(m.authors); });

/** The BCP 47 tag for a LyX language name (the editor element's `lang`, for hyphenation and the browser's spell checker). */
export function bcp47(lyxLang: string): string {
  const t: Record<string, string> = {
    english: 'en', american: 'en-US', british: 'en-GB', german: 'de', ngerman: 'de', french: 'fr', spanish: 'es', italian: 'it',
    dutch: 'nl', portuguese: 'pt', brazilian: 'pt-BR', russian: 'ru', polish: 'pl', czech: 'cs', swedish: 'sv', danish: 'da',
    norsk: 'nb', finnish: 'fi', greek: 'el', turkish: 'tr', hungarian: 'hu', romanian: 'ro', japanese: 'ja', korean: 'ko',
    'chinese-simplified': 'zh-Hans', 'chinese-traditional': 'zh-Hant',
  };
  return t[lyxLang] ?? lyxLang.slice(0, 2);
}

/** A label name for the paragraph at the cursor: `sec:`/`subsec:`/`chap:` + slug, `fig:`/`tab:`/`alg:` inside a float's caption. */
export function suggestLabel(view: EditorView): string {
  const p = currentParagraph(view.state);
  if (!p) return '';
  const layout = p.node.attrs.layout as string;
  const text = p.node.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const prefix = /^Section/.test(layout) ? 'sec:' : /^Subsection/.test(layout) ? 'subsec:' : /^Chapter/.test(layout) ? 'chap:' : 'sec:';
  const $from = view.state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'inset' && n.attrs.name === 'Caption') {
      let ft = 'fig';
      for (let dd = d - 1; dd > 0; dd--) { const f = $from.node(dd); if (f.type.name === 'inset' && f.attrs.name === 'Float') { ft = f.attrs.arg === 'table' ? 'tab' : f.attrs.arg === 'algorithm' ? 'alg' : 'fig'; break; } }
      return `${ft}:${text || 'label'}`;
    }
  }
  return prefix + (text || 'label');
}

export interface DocStats { words: number; chars: number; /** the numbers describe the selection, not the whole document */ sel: boolean }

/**
 * Word / character count for the status bar: the selection when there is one, else the whole
 * document (like LyX's statistics; a math formula or other inset counts as a word boundary).
 */
export function documentStats(view: EditorView): DocStats {
  const { from, to, empty } = view.state.selection;
  const doc: PMNode = view.state.doc;
  const text = doc.textBetween(empty ? 0 : from, empty ? doc.content.size : to, '\n', ' ');
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return { words, chars: text.replace(/\s+/g, '').length, sel: !empty };
}

/** The paragraph layout picker (Alt+P Space or the layout menu): type to filter, Enter takes the first match. */
export function LayoutPicker({ layouts, onPick, onClose }: { layouts: { name: string; category?: string }[]; onPick: (n: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const mode = document.documentElement.dataset.ui === 'modern' ? 'modern' : 'classic';
  const list = layouts.filter(l => styleSearchText(l.name, mode).includes(q.toLowerCase()));
  return (
    <div class="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog"><h2>{mode === 'modern' ? 'Paragraph style' : 'Paragraph layout'}</h2><div class="body">
        <input type="text" autofocus value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter' && list[0]) { onPick(list[0].name); onClose(); } if (e.key === 'Escape') onClose(); }} placeholder="type to filter…" />
        <div class="list">{list.map(l => <div key={l.name} onClick={() => { onPick(l.name); onClose(); }}>{styleLabel(l.name, mode)} {mode !== 'modern' && <span class="sub">{l.category}</span>}</div>)}</div>
      </div></div>
    </div>
  );
}

/** Drag handle beside a sidebar: sets --left-width / --right-width on the root (kept per browser). */
export function SidebarGrip({ side }: { side: 'left' | 'right' }) {
  return (
    <div class={'sidebar-grip ' + side} title="Drag to resize" onPointerDown={(e) => {
      e.preventDefault();
      const move = (ev: PointerEvent) => {
        const w = Math.round(Math.max(180, Math.min(window.innerWidth * 0.6, side === 'left' ? ev.clientX : window.innerWidth - ev.clientX)));
        document.documentElement.style.setProperty(`--${side}-width`, w + 'px');
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        try { localStorage.setItem('ol.' + side + 'w', document.documentElement.style.getPropertyValue(`--${side}-width`)); } catch { /* ignore */ }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }} />
  );
}

/** The sidebar widths a SidebarGrip stored in this browser, applied again (call once when a shell mounts). */
export function restoreSidebarWidths(): void {
  for (const side of ['left', 'right'] as const) {
    try { const w = localStorage.getItem('ol.' + side + 'w'); if (w && /^\d+px$/.test(w)) document.documentElement.style.setProperty(`--${side}-width`, w); } catch { /* ignore */ }
  }
}
