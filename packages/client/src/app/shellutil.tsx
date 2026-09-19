/**
 * Helpers of the editor shells — the web client's Workspace (App.tsx) and the VS Code webview's
 * EditorShell (packages/vscode) — that are about the document rather than the surrounding UI:
 * author colours and ids for change tracking, the document language, label suggestions, the
 * paragraph layout picker, word counts. One copy for both shells (tests/parity.test.ts).
 */
import { useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { currentParagraph } from '../editor/commands';

/**
 * Zoom the document text: a CSS variable the editor's font size is computed from (styles.css
 * `.lyx-editor`), remembered per browser. Both shells use this — never CSS `zoom` on a container,
 * which puts mouse coordinates and the layout into different scales in Chromium (hit tests miss,
 * drags jump, selections and their highlights disagree).
 */
export function applyEditorZoom(zoom: number): void {
  document.documentElement.style.setProperty('--editor-zoom', String(zoom));
  try { localStorage.setItem('ol.zoom', String(zoom)); } catch { /* storage unavailable */ }
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
      + `html[data-theme="dark"] .lyx-change[data-author="${a.id}"], html[data-theme="dark"] .lyx-inset[data-author="${a.id}"] { --change-color: ${dk}; }`;
  }).join('\n');
}

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
  const list = layouts.filter(l => l.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div class="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog"><h2>Paragraph layout</h2><div class="body">
        <input type="text" autofocus value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter' && list[0]) { onPick(list[0].name); onClose(); } if (e.key === 'Escape') onClose(); }} placeholder="type to filter…" />
        <div class="list">{list.map(l => <div key={l.name} onClick={() => { onPick(l.name); onClose(); }}>{l.name} <span class="sub">{l.category}</span></div>)}</div>
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
