/**
 * Helpers of the editor shells — the web client's Workspace (App.tsx) and the VS Code webview's
 * EditorShell (packages/vscode) — that are about the document rather than the surrounding UI:
 * author colours and ids for change tracking, the document language, label suggestions, the
 * paragraph layout picker, word counts. One copy for both shells (tests/parity.test.ts).
 */
import { hostedZoomPill } from './zoomhud';
import { stepOnto, type Detent } from './zoomdetent';
import { useEffect, useState } from 'preact/hooks';
import { styleLabel, styleSearchText } from './stylenames';
import type { EditorView } from 'prosemirror-view';
import { NodeSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { estimatePages } from './pagecount';
import { currentParagraph } from '../editor/commands';
import { editorContext, onMetaChange } from '../editor/context';
import { recordInteraction } from '../usage';
import { isAgentAuthor } from '@overlyx/core/agentname.ts';

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
const textZoomPill = hostedZoomPill(() => document.querySelector<HTMLElement>('.editor-scroll'), 'data-text-zoomhud', 'Text');

/** how far the rendered text size changes (the percentage menu and Ctrl + / −) */
export const TEXT_ZOOM_MIN = 0.5, TEXT_ZOOM_MAX = 2.5;
/** a text-size step stops at 100 % (zoomdetent.ts) */
const TEXT_LEVELS: Detent<'own'>[] = [{ key: 'own', z: 1, hold: Math.log(1.25) }];

/** the text zoom a step from `z` goes to (Ctrl + / −, the status bar's − / +: `d` ±1; 0: 100 %): 10 % on, not past 100 % */
export function stepTextZoom(z: number, d: number): number {
  if (d === 0) return 1;
  const to = stepOnto(z, (z + d * 0.1) / z, TEXT_LEVELS).z;
  return Math.max(TEXT_ZOOM_MIN, Math.min(TEXT_ZOOM_MAX, +to.toFixed(2)));
}

export { useDocumentViewportZoom } from './documentviewport';

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

/**
 * The authors' colours for change tracking: no red and no green (they say deleted / inserted
 * everywhere else, and are the pair colour-blind readers lose), all in one lightness band so that
 * authors differ by hue alone — the age fade below darkens every colour alike. The most distinct
 * come first, for the two or three authors most documents have.
 */
const AUTHOR_COLORS = ['#126bc5', '#cf630d', '#bb3285', '#008396', '#a67b01', '#7451c2', '#9b4ba8'];
// the same hues, lifted so that they read on the dark page (app/theme.ts)
const AUTHOR_COLORS_DARK = ['#90c1fe', '#fca676', '#ff97cd', '#7bccdd', '#dab976', '#c1b0fe', '#e2a3ec'];

/** One colour per LyX author for change tracking (stable across sessions: by author id order). */
export function applyAuthorColors(authors: { id: number; name: string }[]): void {
  let el = document.getElementById('ol-author-colors') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'ol-author-colors'; document.head.appendChild(el); }
  // an agent's tracked changes ("Claude (Opus 5.5) [Jan]", formerly "… (MCP)") are grey by default,
  // so the colours stay for human co-authors and the eye can skim the machine's insertions
  const css = authors.map((a, i) => {
    const light = isAgentAuthor(a.name) ? '#757575' : AUTHOR_COLORS[i % AUTHOR_COLORS.length];
    const dk = isAgentAuthor(a.name) ? '#9e9e9e' : AUTHOR_COLORS_DARK[i % AUTHOR_COLORS_DARK.length];
    // an older change goes into black (into the white text on a dark page) by its --change-age
    // (.ol-scrollmark: the change's mark along the scroll bar, editor/plugins/scrollmarks.ts)
    return `.lyx-change[data-author="${a.id}"], .lyx-inset[data-author="${a.id}"], .ol-scrollmark[data-author="${a.id}"] { --change-color: color-mix(in oklab, ${light}, #000 calc(var(--change-age, 0%) * ${FADE_LIGHT})); }\n`
      // (lifted only on a dark page: with smart invert off the page is white paper, app/darkpages.ts)
      + `html[data-theme="dark"][data-dark-pages] .lyx-change[data-author="${a.id}"], html[data-theme="dark"][data-dark-pages] .lyx-inset[data-author="${a.id}"], html[data-theme="dark"][data-dark-pages] .ol-scrollmark[data-author="${a.id}"] { --change-color: color-mix(in oklab, ${dk}, var(--editor-fg) calc(var(--change-age, 0%) * ${FADE_DARK})); }`;
  }).join('\n');
  // (the same rules again — every metadata fetch brings the authors — would restyle the whole document)
  if (el.textContent !== css) el.textContent = css;
  refreshChangeAges();
}

const HOUR = 3600, YEAR = 365.25 * 24 * HOUR;
/** how far into black the oldest changes go: half way on a light page (darker colours look all
 *  alike on screen), three quarters into the white text on a dark one */
const FADE_LIGHT = 0.5, FADE_DARK = 0.75;

/**
 * How far along its fade a change is at an age (s), 0–1: not at all in its first hour, then
 * slowly at first and faster later along a log clock (1 h → 1 d → 1 w → 1 mo → 1 y) — 0.12 at a
 * day, 0.32 at a week, 0.52 at a month, 0.72 at three months — and all the way at a year, where
 * it stays. FADE_LIGHT / FADE_DARK turn it into the share of black (white).
 */
export function changeAge(age: number): number {
  if (!(age > HOUR)) return 0;
  const s = Math.min(1, Math.log(age / HOUR) / Math.log(YEAR / HOUR));
  return s * s;
}

/**
 * The CSS that gives every tracked change its place on the fade (`--change-age`), without looking
 * at the document: `data-time` is the change's Unix time in decimal, so a run of seconds sharing
 * its leading digits is one prefix selector (`[data-time^="17613"]` = 10⁵ s). A run is at most a
 * quarter of its age long, so the fade hardly changes within it — about 170 runs from 2001 on.
 */
export function changeAgeCss(now: number): string {
  const byPct = new Map<number, string[]>();
  const end = now - HOUR;
  for (let t = 1e9; t <= end;) {
    let w = 1;
    for (;;) {
      const w2 = w * 10, last = t + w2 - 1, young = now - last;
      if (t % w2 !== 0 || last > end || (young < YEAR && w2 * 4 > young)) break;
      w = w2;
    }
    const pct = Math.round(changeAge(now - (t + w / 2)) * 100);
    if (pct) {
      const prefix = String(t).slice(0, 10 - Math.round(Math.log10(w)));
      (byPct.get(pct) ?? byPct.set(pct, []).get(pct)!).push(`.lyx-change[data-time^="${prefix}"], .lyx-inset[data-time^="${prefix}"]`);
    }
    t += w;
  }
  return [...byPct].map(([pct, sel]) => `${sel.join(',\n')} { --change-age: ${pct}%; }`).join('\n');
}

let changeAgesTimer: ReturnType<typeof setInterval> | null = null;
/** the fades follow the clock: recomputed every ten minutes while a document is open */
function refreshChangeAges(): void {
  let el = document.getElementById('ol-change-ages') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'ol-change-ages'; document.head.appendChild(el); }
  const css = changeAgeCss(Math.floor(Date.now() / 1000));
  if (el.textContent !== css) el.textContent = css;
  changeAgesTimer ??= setInterval(refreshChangeAges, 10 * 60 * 1000);
}

/**
 * The pictures of the people in the open project (its owner, its members, oneself — Google sign-in)
 * beside their comments: the avatar circle of a comment header (plugins/numbering.ts, data-author =
 * the name in the header) and of the Comments panel shows the picture instead of the initials.
 */
export function applyCommentAvatars(people: ({ name: string; avatar?: string | null } | null | undefined)[]): void {
  let el = document.getElementById('ol-comment-avatars') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'ol-comment-avatars'; document.head.appendChild(el); }
  const str = (s: string) => '"' + s.replace(/["\\\n]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ') + '"';
  const seen = new Set<string>();
  el.textContent = people.flatMap(p => {
    if (!p?.avatar || !p.name || seen.has(p.name)) return [];
    seen.add(p.name);
    const who = str(p.name);
    return [`.comment-header[data-author=${who}]::before, .comments-panel .avatar[data-author=${who}] { background: url(${str(p.avatar)}) center / cover, hsl(var(--who-hue, 210) 45% 50%); color: transparent; }`];
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

export interface DocStats { words: number; chars: number; /** the numbers describe the selection, not the whole document */ sel: boolean; /** estimated pages at 11pt (app/pagecount.ts) */ pages?: number }

/** a note box or comment: text the PDF does not print (greyed-out text it does, as LyX counts it) */
export const isUnprintedNote = (n: PMNode): boolean => n.type.name === 'inset' && n.attrs.name === 'Note' && n.attrs.arg !== 'Greyedout';

/**
 * The text between `from` and `to` as `doc.textBetween(from, to, '\n', ' ')` gives it, without the
 * notes and comments that start in the range (a selection inside one counts its text).
 */
export function countedText(doc: PMNode, from: number, to: number): string {
  let text = '', first = true;
  doc.nodesBetween(from, to, (node, pos) => {
    if (pos >= from && isUnprintedNote(node)) return false;
    const t = node.isText ? node.text!.slice(Math.max(from, pos) - pos, to - pos) : node.isLeaf ? ' ' : '';
    if (node.isBlock && (node.isLeaf || node.isTextblock)) { if (first) first = false; else text += '\n'; }
    text += t;
    return true;
  });
  return text;
}

/**
 * Word / character count for the status bar: the selection when there is one, else the whole
 * document (like LyX's statistics; a math formula or other inset counts as a word boundary, note
 * boxes and comments are left out), and the pages they would fill at 11pt. A selected object (a
 * picture, a formula, a comment) is no text to count: the document's numbers stay.
 */
export function documentStats(view: EditorView): DocStats {
  const { selection, doc } = view.state;
  const { from, to } = selection;
  const empty = selection.empty || (selection instanceof NodeSelection && !/\S/.test(countedText(doc, from, to)));
  const text = countedText(doc, empty ? 0 : from, empty ? doc.content.size : to);
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  let pages: number | undefined;
  try { pages = doc.firstChild?.type.name === 'ol_page' ? undefined : empty ? estimatePages(doc) : estimatePages(doc.cut(from, to), false); } catch { pages = undefined; }
  return { words, chars: text.replace(/\s+/g, '').length, sel: !empty, pages };
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
      // (kept by the grip: a frame under the pointer — a slide, an article's block — would take the moves and the release)
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
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
