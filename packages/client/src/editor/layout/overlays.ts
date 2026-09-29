/**
 * Beamer's overlays in text, for the presentation: what a frame shows on each of its slides.
 *
 * The presentation works on a copy of the editor's DOM (layout pages, or a linear deck's frames —
 * beamerslides.ts); paragraphs carry their layout (`data-layout`), insets their name and argument
 * (`data-name`, `data-arg`), so the overlay specifications are read from there:
 * - a Pause paragraph or an inline `\pause`: what follows is covered until the next slide;
 * - `\item<2->` (the item's overlay argument) and a list's default overlay `[<+->]`;
 * - `\only<…>{}` (absent otherwise), `\uncover<…>{}` / `\visible<…>{}` (covered: the room stays),
 *   `\invisible<…>{}`, `\alert<…>{}` (alerted on those slides), `\textbf<…>{}`, `\emph<…>{}`,
 *   `\alt<…>{a}{b}` (a on those slides, b on the others);
 * - blocks with an overlay specification.
 *
 * `+` in a specification counts like beamer's `beamerpauses`: it is replaced by the counter, which
 * then goes up by one (`.` is the value the last `+` had; `+(1)`, `.(-1)` offset it); a pause
 * increases the counter and shows what follows from there. Mode-specific parts
 * (`handout:0`, `article:…`) are dropped, `beamer:` / `presentation:` ones kept.
 */

export type OverlayMode = 'uncover' | 'only' | 'invisible' | 'alert' | 'bold' | 'emph' | 'alt';

const FLEX_MODES: Record<string, OverlayMode> = {
  Only: 'only', Uncover: 'uncover', Visible: 'uncover', Invisible: 'invisible', Alert: 'alert',
  Structure: 'alert', Bold: 'bold', Emphasize: 'emph', Alternative: 'alt',
};
const ITEM_LAYOUTS = new Set(['Itemize', 'Enumerate', 'Description']);
/** environments whose first argument is an action specification (\begin{block}<2->, \begin{proof}<3>) */
export const BLOCK_LAYOUTS = new Set(['Block', 'ExampleBlock', 'AlertBlock', 'Theorem', 'Proof', 'Corollary', 'Definition', 'Definitions', 'Example', 'Examples', 'Fact', 'Lemma', 'Quotation', 'Quote', 'Verse']);

/** The counter of a frame (beamer's beamerpauses) while its content is read in order. */
export class OverlayCounter {
  value = 1;
  last = 0;
  max = 1;
  /** A specification with `+` and `.` replaced by slide numbers (null: no specification). */
  resolve(spec: string | null | undefined): string | null {
    if (!spec) return null;
    let s = spec.replace(/\s+/g, '');
    // mode-specific parts: the presentation is beamer's own mode
    const parts = s.split('|').map(p => p.trim()).filter(p => !/^(handout|article|trans|second):/.test(p)).map(p => p.replace(/^(beamer|presentation):/, ''));
    if (!parts.length) return '';
    s = parts.join(',');
    let plus = false;
    s = s.replace(/([+.])(?:\((-?\d+)\))?/g, (_m, c: string, off?: string) => {
      const o = off ? Number(off) : 0;
      if (c === '+') { plus = true; return String(this.value + o); }
      return String(Math.max(1, (this.last || this.value) + o));
    });
    if (plus) { this.last = this.value; this.value++; }
    for (const d of s.match(/\d+/g) ?? []) this.max = Math.max(this.max, Number(d));
    return s;
  }
  /** `\pause`: what follows is shown from the next slide on. */
  pause(): string {
    this.value++;
    this.max = Math.max(this.max, this.value);
    return `${this.value}-`;
  }
}

/** Is a specification (numbers only: `2-`, `-3`, `1,3-5`, `alert@2`) on slide `n`? */
export function specOn(spec: string | null | undefined, n: number): boolean {
  if (spec === null || spec === undefined) return true;
  if (spec === '') return false;   // only for another mode (handout:…): never in the presentation
  for (const part of spec.split(',')) {
    const p = part.trim().replace(/^[a-z]+@/, '');
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(p);
    if (m) { const a = m[1] ? Number(m[1]) : 1, b = m[2] ? Number(m[2]) : Infinity; if (n >= a && n <= b) return true; continue; }
    if (/^\d+$/.test(p) && Number(p) === n) return true;
  }
  return false;
}

/** the text of an inset's argument (an Argument inset `id` in its first paragraph), or null */
function argText(el: Element, id: string): string | null {
  for (const a of el.querySelectorAll<HTMLElement>(':scope > .inset-box > .inset-content > .lyx-par > .lyx-inset[data-name="Argument"]')) {
    if (a.dataset.arg === id) return (a.querySelector('.inset-content')?.textContent ?? '').trim();
  }
  return null;
}

/** an Argument inset `id` of a paragraph (directly in it) */
function parArg(p: Element, id: string): string | null {
  for (const a of p.querySelectorAll<HTMLElement>(':scope > .lyx-inset[data-name="Argument"]')) {
    if (a.dataset.arg === id) return (a.querySelector('.inset-content')?.textContent ?? '').trim();
  }
  return null;
}

function mark(el: HTMLElement, spec: string | null, mode: OverlayMode): void {
  if (spec === null) return;
  el.dataset.ov = spec;
  el.dataset.ovMode = mode;
}

/**
 * Read the overlays of `paragraphs` (the text of a frame or a text box, in order) with `counter`,
 * marking the elements (`data-ov`, `data-ov-mode`); returns the counter's highest slide.
 */
export function annotateOverlays(paragraphs: HTMLElement[], counter = new OverlayCounter()): number {
  let pauseSpec: string | null = null;
  let listDefault: { key: string; spec: string } | null = null;
  let block: { depth: number; spec: string | null } | null = null;
  for (const p of paragraphs) {
    const layout = p.dataset.layout ?? '';
    const depth = Number(p.dataset.depth ?? 0);
    if (layout === 'Pause') {
      // \pause[n]: from slide n; else the next one
      const n = parArg(p, '1');
      pauseSpec = n && /^\d+$/.test(n) ? `${n}-` : counter.pause();
      if (n && /^\d+$/.test(n)) { counter.value = Number(n); counter.max = Math.max(counter.max, counter.value); }
      p.dataset.ovMode = 'gone';
      continue;
    }
    if (pauseSpec) mark(p, pauseSpec, 'uncover');
    // a block with an overlay specification: it and what is nested in it
    if (block && depth <= block.depth && !(depth === block.depth && BLOCK_LAYOUTS.has(layout))) block = null;
    if (BLOCK_LAYOUTS.has(layout) && (!block || depth <= block.depth)) {
      const first = !(p.previousElementSibling instanceof HTMLElement && p.previousElementSibling.dataset.layout === layout && Number(p.previousElementSibling.dataset.depth ?? 0) === depth);
      if (first) block = { depth, spec: counter.resolve(parArg(p, '1')) };
    }
    if (block?.spec && !p.dataset.ov) { mark(p, block.spec, 'uncover'); p.dataset.ovBlock = '1'; }
    // list items: their own overlay argument, else the list's default ([<+->])
    if (ITEM_LAYOUTS.has(layout)) {
      const key = layout + ':' + depth;
      const prev = p.previousElementSibling as HTMLElement | null;
      const continues = !!prev && prev.dataset.layout === layout && Number(prev.dataset.depth ?? 0) === depth;
      const dflt = parArg(p, '1');
      if (!continues || (listDefault && listDefault.key !== key)) listDefault = dflt ? { key, spec: dflt } : null;
      else if (dflt) listDefault = { key, spec: dflt };
      const own = parArg(p, layout === 'Description' ? 'item:1' : 'item:2') ?? (layout === 'Description' ? null : parArg(p, 'item:1')?.match(/^<(.*)>$/)?.[1] ?? null);
      const spec = counter.resolve(own ?? (listDefault?.key === key ? listDefault.spec : null));
      if (spec !== null) {
        // an item under a pause: both apply (the pause wraps the item)
        if (p.dataset.ov) { const wrap = p.dataset.ov; p.dataset.ov = spec; p.dataset.ovMode = 'uncover'; p.dataset.ovOuter = wrap; }
        else mark(p, spec, 'uncover');
      }
    }
    // inline overlays: \pause in the text, Flex insets with a specification
    inlineOverlays(p, counter, (s) => { pauseSpec = s; });
  }
  return counter.max;
}

/** the inline part: walks the paragraph's own content in order (nested insets' paragraphs too) */
function inlineOverlays(p: HTMLElement, counter: OverlayCounter, setPause: (s: string) => void): void {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      const e = n as HTMLElement;
      // argument insets are read by their owners
      if (e.classList.contains('lyx-inset') && e.dataset.name === 'Argument') return NodeFilter.FILTER_REJECT;
      return e.classList.contains('lyx-inset') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const pauses: HTMLElement[] = [], alts: HTMLElement[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const e = n as HTMLElement;
    if (e.dataset.name === 'ERT') {
      if (/^\s*\\pause\b/.test(e.textContent ?? '')) { pauses.push(e); e.dataset.ovMode = 'gone'; e.dataset.ovPause = counter.pause(); }
      continue;
    }
    if (e.dataset.name !== 'Flex') continue;
    const mode = FLEX_MODES[e.dataset.arg ?? ''];
    if (!mode) continue;
    const spec = counter.resolve(argText(e, '1'));
    if (spec === null) continue;
    mark(e, spec, mode);
    if (mode === 'alt') alts.push(e);
  }
  // \alt<…>{a}{b}: a is the inset's argument 2, b its content — wrapped, so that it can be hidden while a shows
  for (const e of alts) {
    for (const par of e.querySelectorAll<HTMLElement>(':scope > .inset-box > .inset-content > .lyx-par')) {
      const wrap = document.createElement('span');
      wrap.className = 'ol-alt-else';
      for (const c of [...par.childNodes]) if (!(c instanceof HTMLElement && c.classList.contains('lyx-inset-argument'))) wrap.append(c);
      par.append(wrap);
    }
  }
  // an inline \pause: what follows it in the paragraph is covered until its slide
  for (const ert of pauses) {
    const spec = ert.dataset.ovPause!;
    setPause(spec);
    let node: ChildNode | null = ert.nextSibling;
    if (!node) continue;
    const wrap = document.createElement('span');
    wrap.className = 'ol-ov-after-pause';
    ert.after(wrap);
    node = wrap.nextSibling;
    while (node) { const next = node.nextSibling; wrap.append(node); node = next; }
    mark(wrap, spec, 'uncover');
    // the ancestors' later siblings (the pause sits in a nested inset): covered too
    for (let a: HTMLElement | null = wrap.parentElement; a && a !== p; a = a.parentElement) {
      let s = a.nextSibling;
      while (s) { const next = s.nextSibling; if (s instanceof HTMLElement) { if (!s.dataset.ov) mark(s, spec, 'uncover'); } else if (s.textContent?.trim()) { const w = document.createElement('span'); s.before(w); w.append(s); mark(w, spec, 'uncover'); } s = next; }
    }
  }
}

/** Show slide `n` of an annotated copy: cover, remove, alert what its specifications say. */
export function applyOverlays(root: HTMLElement, n: number): void {
  for (const e of root.querySelectorAll<HTMLElement>('[data-ov-mode]')) {
    const mode = e.dataset.ovMode;
    if (mode === 'gone') { e.classList.add('ol-gone'); continue; }
    const on = specOn(e.dataset.ov, n) && specOn(e.dataset.ovOuter, n);
    e.classList.toggle('ol-gone', mode === 'only' && !on);
    e.classList.toggle('ol-hidden', (mode === 'uncover' && !on) || (mode === 'invisible' && on));
    e.classList.toggle('ol-ov-alert', mode === 'alert' && on);
    e.classList.toggle('ol-ov-bold', mode === 'bold' && on);
    e.classList.toggle('ol-ov-emph', mode === 'emph' && on);
    // \alt: its first text (argument 2) on the specified slides, the second (the content) on the others
    e.classList.toggle('ol-ov-alt', mode === 'alt' && on);
  }
}
