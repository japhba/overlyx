/**
 * MathJax 4 — the renderer of every formula on screen: the editor's fields and static formulas
 * (field.ts), the toolbars' symbol palettes, the settings preview, the agent panel.
 *
 * A TeX input jax with LyX's command set (mathjax-tex.ts) and a CHTML output jax for the chosen
 * math font (Settings ▸ Editor ▸ Math font; mathfonts.ts): MathJax lays formulas out from the
 * font's OpenType MATH data — its spacing, radicals, wide accents and extensible delimiters. The
 * markup is MathJax's own, plus `data-sl` (the script level) on the editor's cell and atom boxes.
 * MathJax loads a font's data per Unicode block on demand, asynchronously: a formula that needs a
 * block not yet loaded comes back with `retry` (render it again once that promise settles). The
 * blocks formulas usually need are fetched at startup (`mathReady`).
 */
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { CHTML } from '@mathjax/src/js/output/chtml.js';
import { browserAdaptor } from '@mathjax/src/js/adaptors/browserAdaptor.js';
import { HTMLDocument } from '@mathjax/src/js/handlers/html/HTMLDocument.js';
import { ChtmlWrapper } from '@mathjax/src/js/output/chtml/Wrapper.js';
import { CommonWrapper } from '@mathjax/src/js/output/common/Wrapper.js';
import type { MmlNode } from '@mathjax/src/js/core/MmlTree/MmlNode.js';
import { makeTexInput, withFormula } from './mathjax-tex';
import { isMathFont, loadMathFont, whenMathFontLoaded, loadFontModule, type LoadedMathFont } from './mathfonts';

/* ------------------------------------------------------------------ output */

// the source of every node would be copied into the markup (the editor's sources are long)
Object.assign((CommonWrapper as unknown as { skipAttributes: Record<string, boolean> }).skipAttributes, { 'data-latex': true, 'data-latex-item': true });
// The editor's cell and atom boxes carry their script level (`data-sl`): MathJax scales only the
// characters inside, and the caret takes the size of the cell's font (geometry.ts).
{
  const proto = ChtmlWrapper.prototype as unknown as { handleAttributes(): void; node: MmlNode; dom: HTMLElement[] };
  const handle = proto.handleAttributes;
  proto.handleAttributes = function (this: typeof proto) {
    handle.call(this);
    const cls = this.node.attributes.get('class');
    if (typeof cls === 'string' && /(?:^|\s)lm-(?:a|c\d+)(?:\s|$)/.test(cls)) {
      const sl = this.node.attributes.get('scriptlevel');
      for (const d of this.dom) d.setAttribute('data-sl', String(sl ?? 0));
    }
  };
}

// Text of \text{…} is set in the editor's text font (mtextInheritFont), measured when the formula is
// rendered — maybe before that font has loaded, or before another one is chosen: its width is left
// to the browser instead of fixed to the measurement.
{
  const proto = CHTML.prototype as unknown as { unknownText(text: string, variant: string, width?: number | null): HTMLElement };
  const unknownText = proto.unknownText;
  proto.unknownText = function (this: typeof proto, text: string, variant: string, width: number | null = null) {
    return unknownText.call(this, text, variant, variant === '-explicitFont' ? null : width);
  };
}

/* ------------------------------------------------------------------ documents per font */

interface Renderer {
  font: LoadedMathFont;
  html: HTMLDocument<HTMLElement, Text, Document>;
  chtml: CHTML<HTMLElement, Text, Document>;
  sheet: HTMLStyleElement | null;
  /** the preloaded blocks have arrived */
  ready: Promise<void> | null;
  dispose(): void;
}

let adaptor: ReturnType<typeof browserAdaptor> | null = null;
const renderers = new Map<string, Renderer>();

function makeRenderer(font: LoadedMathFont): Renderer {
  if (!adaptor) {
    adaptor = browserAdaptor();
    // font data (per Unicode block) comes through the bundler's dynamic imports
    mathjax.asyncLoad = (file: string) => loadFontModule(file);
  }
  const tex = makeTexInput();
  const chtml = new CHTML<HTMLElement, Text, Document>({
    fontData: font.data,
    linebreaks: { inline: false },
    matchFontHeight: false,
    mtextInheritFont: true,
  } as never);
  // (made directly: MathJax's handler lookup would test `document instanceof Document`, which fails in happy-dom)
  const html = new HTMLDocument<HTMLElement, Text, Document>(document, adaptor, { InputJax: tex, OutputJax: chtml } as never);
  const r: Renderer = {
    font, html, chtml, sheet: null, ready: null,
    // (disabled, not removed: a style sheet taken out of the page loses the rules MathJax inserted since)
    dispose() { if (r.sheet) r.sheet.disabled = true; },
  };
  if (font.extension) {
    // its fonts' CSS goes into the style sheet MathJax has at that moment, which must be in the page
    updateSheet(r);
    chtml.addExtension(font.extension as never, `@mathjax/${(font.extension as { name: string }).name}-font-extension/js/chtml/dynamic`);
  }
  return r;
}

let fontId = 'newcm';
let active: Renderer | null = null;
let version = 0;
const listeners = new Set<() => void>();
function bump(): void { version++; for (const l of listeners) { try { l(); } catch { /* ignore */ } } }

/** called when every formula has to be rendered again (another math font, or its data arrived) */
export function onMathRendererChange(cb: () => void): () => void { listeners.add(cb); return () => listeners.delete(cb); }
/** changes whenever formulas rendered before are stale */
export function mathRendererVersion(): number { return version; }

function renderer(): Renderer | null {
  if (typeof document === 'undefined') return null;
  if (active && active.font.id === fontId) return active;
  const font = loadMathFont(fontId);
  if (font) return switchTo(font);
  // the chosen font's module is on its way (setMathFont): meanwhile the default font, which is always there
  return active && active.font.id === 'newcm' ? active : switchTo(loadMathFont('newcm')!);
}

function switchTo(font: LoadedMathFont): Renderer {
  let r = renderers.get(font.id);
  if (!r) { r = makeRenderer(font); renderers.set(font.id, r); }
  if (active && active !== r) active.dispose();
  active = r;
  // the blocks formulas usually need, in the background (a formula that needs one first renders again once it is here)
  void mathReady();
  return r;
}

/** The math font formulas are drawn with (an id of fonts/catalog.ts MATH_FONTS). */
export function setMathFont(id: string): void {
  const next = isMathFont(id) ? id : 'newcm';
  if (next === fontId) return;
  fontId = next;
  active?.dispose();
  active = null;
  // its module comes separately: everything is drawn again once it has arrived
  if (!loadMathFont(next)) void whenMathFontLoaded(next).then(ok => { if (ok && fontId === next) { active?.dispose(); active = null; bump(); } });
  bump();
}
export function currentMathFont(): string { return fontId; }

/* ------------------------------------------------------------------ rendering */

export interface RenderOptions {
  /** \displaystyle (the formula stays an inline box: the node view lays display formulas out) */
  display?: boolean;
  /** the document's argument-less macros, name (with or without the backslash) → definition */
  macros?: Record<string, string>;
  /** an image file of \includegraphics → its URL */
  image?: (src: string) => string;
}

export interface Rendered {
  /** the mjx-container, or null (an error, or font data still loading) */
  node: HTMLElement | null;
  /** the TeX error, if the formula has one */
  error: string | null;
  /** settles when the formula should be rendered again (font data or an image's shape arrived) */
  retry: Promise<void> | null;
  /** commands MathJax does not know (drawn as their names in red) */
  undefinedCommands: string[];
}

export function renderMath(tex: string, opts: RenderOptions = {}): Rendered {
  const r = renderer();
  if (!r) return { node: null, error: null, retry: fontLoading(), undefinedCommands: [] };
  try {
    const { value: node, images, undefinedCommands } = withFormula(opts.macros, opts.image, () =>
      r.html.convert((opts.display ? '\\displaystyle ' : '') + tex, { display: false, em: 16, ex: 16 * r.chtml.font.params.x_height, containerWidth: 1e5 }) as HTMLElement);
    updateSheet(r);
    return { node, error: null, retry: images.length ? Promise.all(images).then(() => {}) : null, undefinedCommands };
  } catch (err) {
    const e = err as Error & { retry?: Promise<unknown> };
    if (e?.retry) return { node: null, error: null, retry: e.retry.then(() => {}, () => {}), undefinedCommands: [] };
    return { node: null, error: e?.message ? String(e.message) : String(err), retry: null, undefinedCommands: [] };
  }
}

/** the renderer's style sheet, in the page and enabled, with the rules of what it rendered since */
function updateSheet(r: Renderer): void {
  const sheet = r.chtml.styleSheet(r.html as never) as unknown as HTMLStyleElement;
  if (sheet !== r.sheet || !sheet.isConnected) {
    r.sheet = sheet;
    document.head.appendChild(sheet);
  }
  if (sheet.disabled) sheet.disabled = false;
}

/* ------------------------------------------------------------------ font data */

let fontWait: Promise<void> | null = null;
function fontLoading(): Promise<void> {
  return fontWait ??= new Promise<void>(resolve => { const off = onMathRendererChange(() => { off(); fontWait = null; resolve(); }); });
}

/**
 * Settles once the current math font's data for the Unicode blocks formulas usually need has
 * arrived (formulas then render without a retry).
 */
export function mathReady(): Promise<void> {
  const r = renderer();
  if (!r) return fontLoading().then(() => mathReady());
  return r.ready ??= (async () => {
    const font = r.chtml.font as unknown as { CLASS: { dynamicFiles: Record<string, object> }; loadDynamicFile(d: object): Promise<void> };
    const files = font.CLASS.dynamicFiles;
    await Promise.all(r.font.preloadBlocks.filter(b => files[b]).map(b => font.loadDynamicFile(files[b]).catch(() => {})));
  })();
}
