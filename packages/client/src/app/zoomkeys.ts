/**
 * Ctrl/⌘ + and − (and 0) zoom what the user is looking at — the document's text, the PDF, the page
 * beside an article — never the browser around it, nor, in VS Code, the whole window: the
 * extension binds these keys to nothing while one of its editors is active (packages/vscode
 * package.json `overlyx.editorKey`), and its webviews zoom with them here.
 *
 * A pane that zooms itself registers its element (`zoomTarget`); a key goes to the pane last pressed
 * on, else the one holding the focus, else to the shell's own zoom (`setDefaultZoom`: the text, which
 * has no Ctrl+0 — a paragraph style there). A webview with one pane and no default (a PDF on its own)
 * zooms that pane. A page in a frame (the article's Page pane) takes its keys itself: they never
 * reach this window (runtime/viewzoom.ts).
 */
export type ZoomStep = 1 | -1 | 0;
type Zoomer = (d: ZoomStep) => void;

const targets = new Map<HTMLElement, Zoomer>();
let fallback: ((d: 1 | -1) => void) | null = null;
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
  const only = targets.size === 1 && !fallback ? [...targets.values()][0] : null;
  const z = targetOf(lastDown) ?? targetOf(active) ?? only;
  if (z) { ev.preventDefault(); ev.stopPropagation(); z(d); return; }
  if (!fallback || d === 0) return;
  ev.preventDefault(); ev.stopPropagation();
  fallback(d);
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

/** the shell's zoom for everything else (the document's text); + and − only */
export function setDefaultZoom(zoom: (d: 1 | -1) => void): () => void {
  install();
  fallback = zoom;
  return () => { if (fallback === zoom) fallback = null; };
}
