/**
 * Ctrl/⌘ + and − (and 0) zoom what the user is looking at — the document's text, the PDF, the page
 * beside an article — never the browser around it, nor, in VS Code, the whole window: the
 * extension binds these keys to nothing while one of its editors is active (packages/vscode
 * package.json `overlyx.editorKey`), and its webviews zoom with them here.
 *
 * A pane that zooms itself registers its element (`zoomTarget`); a key goes to the pane last pressed
 * on, else the one holding the focus, else to the shell's own zoom (`setDefaultZoom`: the text, which
 * has no Ctrl+0 — a paragraph style there). An editor shown in the shell's place (a slide deck) sets a
 * default of its own over the shell's while it is open (the latest one set is used): the keys pressed
 * with the focus on its toolbar zoomed the last document's text instead ("Text · 140 %" over a deck). A webview with one pane and no default (a PDF on its own)
 * zooms that pane. A page in a frame (the article's Page pane) takes its keys itself: they never
 * reach this window (runtime/viewzoom.ts).
 */
export type ZoomStep = 1 | -1 | 0;
type Zoomer = (d: ZoomStep) => void;

const targets = new Map<HTMLElement, Zoomer>();
/** the defaults set, the latest last (`zero`: it takes Ctrl+0 too) */
const fallbacks: { zoom: (d: ZoomStep) => void; zero: boolean }[] = [];
let lastDown: Node | null = null;
let installed = false;

/** the zoom step a key asks for, or null when it is not one */
export function zoomKeyOf(ev: KeyboardEvent): ZoomStep | null {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? ev.metaKey : ev.ctrlKey;
  if (!mod || ev.altKey) return null;
  // (Shift+= is + on most layouts: allowed for it alone)
  if (ev.key === '+' || (!ev.shiftKey && (ev.code === 'Equal' || ev.code === 'NumpadAdd'))) return 1;
  if (ev.shiftKey) return null;
  if (ev.key === '-' || ev.code === 'Minus' || ev.code === 'NumpadSubtract') return -1;
  if (ev.key === '0' || ev.code === 'Numpad0') return 0;
  return null;
}

function targetOf(n: Node | null): Zoomer | null {
  if (!n) return null;
  for (const [el, z] of targets) if (el.isConnected && el.contains(n)) return z;
  return null;
}

function onKey(ev: KeyboardEvent): void {
  if (ev.defaultPrevented) return;
  const d = zoomKeyOf(ev);
  if (d === null) return;
  const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const fallback = fallbacks[fallbacks.length - 1] ?? null;
  const only = targets.size === 1 && !fallback ? [...targets.values()][0] : null;
  const z = targetOf(lastDown) ?? targetOf(active) ?? only;
  if (z) { ev.preventDefault(); ev.stopPropagation(); z(d); return; }
  if (!fallback || (d === 0 && !fallback.zero)) return;
  ev.preventDefault(); ev.stopPropagation();
  fallback.zoom(d);
}

function install(): void {
  if (installed) return;
  installed = true;
  addEventListener('pointerdown', e => { lastDown = e.target instanceof Node ? e.target : null; }, true);
  addEventListener('keydown', onKey, true);
}

/** a pane that zooms itself: the keys go to it while it is where the user last pressed or the focus is */
export function zoomTarget(el: HTMLElement, zoom: Zoomer): () => void {
  install();
  targets.set(el, zoom);
  return () => { if (targets.get(el) === zoom) targets.delete(el); };
}

/** the shell's zoom for everything else (the document's text; + and − only), or an editor's in its place while it is open (`zero`: Ctrl+0 too) */
export function setDefaultZoom(zoom: (d: ZoomStep) => void, zero = false): () => void {
  install();
  const entry = { zoom, zero };
  fallbacks.push(entry);
  return () => { const i = fallbacks.indexOf(entry); if (i >= 0) fallbacks.splice(i, 1); };
}
