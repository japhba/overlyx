/**
 * Copy, cut and paste of objects on the canvas.
 *
 * A click on the canvas leaves the keyboard in the editor around the frame, so Ctrl+C / X / V mostly
 * reach the editor, not this page. The editor copies what this module keeps ready (`clip`, sent
 * again whenever the selection or the text changes: a copy event has to be answered at once) and
 * passes a paste on (`paste`). With the keyboard in the frame, edit.ts's own clipboard events come here
 * the same way.
 *
 * Copied: each object's source. The parts of a drawing (shapes inside an SVG) are copied as a drawing
 * of their own: an <svg> fitted around them at the place on the slide where they were, with the
 * transforms and paint of the groups they were in.
 * Pasted: onto the slide in view, where the objects were (beside them on the slide they came from;
 * each paste of the same objects a step further). Parts of a drawing go into the drawing selected
 * there (in front of the part selected), in that drawing's units and at the same place on the slide;
 * with no drawing selected they are that drawing of their own.
 */
import type { HtmlOp, Path } from '../protocol';
import { post, state, srcOf, pathOf, slides, slideOf, docRect } from './env';
import { isSvgPart, isLocked, selection, commit, visibleSlideEl } from './edit';
import { isSolo } from './solo';

const MARK = /<!--overlyx-objects(?: from=(-?\d+))?-->/;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** a drawing's attributes its parts inherit (its size, place and units are its own) */
const INHERITED = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'paint-order', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'clip-rule', 'visibility']);
/** a group's attributes that are not paint for its parts (as when it is ungrouped, arrange.ts) */
const G_OWN = new Set(['id', 'class', 'transform', 'style']);

const n4 = (v: number) => String(Math.round(v * 1e4) / 1e4 || 0);
const sig = (v: number) => String(Number(v.toPrecision(6)) || 0);

/** a matrix as a transform attribute: a translate and a scale when it is no more, else matrix(…); null: none */
function matrixText(m: DOMMatrix): string | null {
  if (Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.a - m.d) < 1e-9 && m.a > 0) {
    const out: string[] = [];
    if (Math.abs(m.e) >= 5e-4 || Math.abs(m.f) >= 5e-4) out.push(`translate(${n4(m.e)} ${n4(m.f)})`);
    if (Math.abs(m.a - 1) >= 1e-6) out.push(`scale(${sig(m.a)})`);
    return out.join(' ') || null;
  }
  return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(sig).join(' ')})`;
}

/** document px → the slide's own px */
function slideMatrix(slide: HTMLElement): DOMMatrix {
  const sr = docRect(slide);
  const k = slide.offsetWidth ? sr.w / slide.offsetWidth : 1;
  return new DOMMatrix().scale(1 / k).translate(-sr.x - slide.clientLeft, -sr.y - slide.clientTop);
}

/** the units of an SVG element's content (a drawing's, a group's) → the slide's px */
function unitsToSlide(el: SVGGraphicsElement, slide: HTMLElement): DOMMatrix | null {
  const m = el.getScreenCTM();
  return m ? slideMatrix(slide).multiply(new DOMMatrix().translate(scrollX, scrollY)).multiply(DOMMatrix.fromMatrix(m)) : null;
}

/** the drawing a part is in: its outermost <svg> */
function drawingOf(el: Element): SVGSVGElement | null {
  let s = (el as SVGGraphicsElement).ownerSVGElement;
  while (s?.ownerSVGElement) s = s.ownerSVGElement;
  return s && srcOf.has(s) ? s : null;
}

/** a part's source in the drawing's own units: the transforms and paint of the groups it is in put on it */
function partHtml(el: SVGGraphicsElement, drawing: SVGSVGElement): string | null {
  const src = srcOf.get(el), dsrc = srcOf.get(drawing);
  if (!src || !dsrc) return null;
  const copy = src.cloneNode(true) as Element;
  let t = '';
  for (let a = src.parentElement; a && a !== dsrc; a = a.parentElement) {
    if (a.localName !== 'g') {
      // inside a nested <svg> (or a link): its parent's units as the drawing's, one matrix
      const P = (el.parentNode as SVGGraphicsElement).getScreenCTM?.(), D = drawing.getScreenCTM();
      t = P && D ? matrixText(DOMMatrix.fromMatrix(D).inverse().multiply(DOMMatrix.fromMatrix(P))) ?? '' : '';
      break;
    }
    const at = a.getAttribute('transform');
    if (at) t = `${at} ${t}`;
    for (const x of Array.from(a.attributes)) if (!G_OWN.has(x.name) && !x.name.startsWith('data-') && !copy.hasAttribute(x.name)) copy.setAttribute(x.name, x.value);
  }
  for (const x of Array.from(dsrc.attributes)) if (INHERITED.has(x.name) && !copy.hasAttribute(x.name)) copy.setAttribute(x.name, x.value);
  const all = `${t} ${copy.getAttribute('transform') ?? ''}`.trim();
  if (all) copy.setAttribute('transform', all);
  return copy.outerHTML;
}

/** parts of one drawing as a drawing of their own: an <svg> fitted around them, where they are on the slide */
function partsHtml(drawing: SVGSVGElement, parts: SVGGraphicsElement[]): string | null {
  const slide = slideOf(drawing), D = drawing.getScreenCTM();
  const U = slide && unitsToSlide(drawing, slide);
  if (!slide || !D || !U) return null;
  const toUnits = DOMMatrix.fromMatrix(D).inverse();
  // their box in the drawing's units, with half their outlines
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) {
    let bb: DOMRect;
    try { bb = p.getBBox(); } catch { continue; }
    const P = p.getScreenCTM();
    if (!P) continue;
    const M = toUnits.multiply(DOMMatrix.fromMatrix(P));
    const c = getComputedStyle(p);
    const sw = p.localName !== 'g' && c.stroke && c.stroke !== 'none' ? (parseFloat(c.strokeWidth) || 0) / 2 * Math.sqrt(Math.abs(M.a * M.d - M.b * M.c)) : 0;
    for (const [x, y] of [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]) {
      const q = M.transformPoint(new DOMPoint(x, y));
      x0 = Math.min(x0, q.x - sw); y0 = Math.min(y0, q.y - sw); x1 = Math.max(x1, q.x + sw); y1 = Math.max(y1, q.y + sw);
    }
  }
  if (!Number.isFinite(x0)) return null;
  // whole px of the slide, and the drawing's units of that box (so the parts land exactly where they were)
  const a = U.transformPoint(new DOMPoint(x0, y0)), b = U.transformPoint(new DOMPoint(x1, y1));
  const L = Math.floor(Math.min(a.x, b.x)), T = Math.floor(Math.min(a.y, b.y));
  const R = Math.max(Math.ceil(Math.max(a.x, b.x)), L + 1), B = Math.max(Math.ceil(Math.max(a.y, b.y)), T + 1);
  const Ui = U.inverse();
  const p0 = Ui.transformPoint(new DOMPoint(L, T)), p1 = Ui.transformPoint(new DOMPoint(R, B));
  const vb = [Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y)];
  const stretched = Math.abs(Math.abs(U.a) - Math.abs(U.d)) > 1e-6 * Math.abs(U.a);
  const inner = parts.map(p => partHtml(p, drawing)).filter((h): h is string => !!h);
  if (!inner.length) return null;
  return `<svg xmlns="${SVG_NS}" viewBox="${vb.map(n4).join(' ')}"${stretched ? ' preserveAspectRatio="none"' : ''} style="position: absolute; left: ${L}px; top: ${T}px; width: ${R - L}px; height: ${B - T}px; overflow: visible" data-ol-clip="parts">\n  ${inner.join('\n  ')}\n</svg>`;
}

const inOrder = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

/** what copying `sel` puts on the clipboard (null: nothing to copy) */
export function clipOf(sel: Element[]): { html: string; plain: string } | null {
  const els = sel.filter(e => e.isConnected && srcOf.has(e) && !sel.some(o => o !== e && o.contains(e))).sort(inOrder);
  if (!els.length) return null;
  const items: (string | { drawing: SVGSVGElement; parts: SVGGraphicsElement[] })[] = [];
  for (const el of els) {
    const d = isSvgPart(el) ? drawingOf(el) : null;
    if (!d) { items.push(srcOf.get(el)!.outerHTML); continue; }
    const same = items.find((x): x is { drawing: SVGSVGElement; parts: SVGGraphicsElement[] } => typeof x !== 'string' && x.drawing === d);
    if (same) same.parts.push(el as SVGGraphicsElement); else items.push({ drawing: d, parts: [el as SVGGraphicsElement] });
  }
  const out = items.map(x => (typeof x === 'string' ? x : partsHtml(x.drawing, x.parts))).filter((h): h is string => !!h);
  if (!out.length) return null;
  const s = slideOf(els[0]);
  const plain = out.join('\n');
  return { html: `<!--overlyx-objects from=${s ? slides().indexOf(s) : -1}-->${plain}`, plain };
}

let lastClip: string | null | undefined;
/** the editor told what a copy of the selection is now (it answers Ctrl+C with it) */
export function postClip(sel: Element[]): void {
  const c = clipOf(sel);
  const key = c ? c.html : null;
  if (key === lastClip) return;
  lastClip = key;
  post({ ol: 'clip', html: c?.html ?? null, plain: c?.plain ?? null });
}

/** where a paste goes: the slide in view (one slide on the canvas), else the selection's */
function pasteSlide(sel: Element[]): HTMLElement | null {
  const own = sel[0] ? slideOf(sel[0]) : null;
  return isSolo() ? visibleSlideEl() : own ?? visibleSlideEl();
}

/** the drawing that parts are pasted into: the one selected on that slide, or the one of the part selected */
function drawingTarget(sel: Element[], slide: HTMLElement | null): { parent: SVGGraphicsElement; index: number } | null {
  if (sel.length !== 1 || !slide || slideOf(sel[0]) !== slide) return null;
  const el = sel[0];
  if (el.localName === 'svg' && el instanceof SVGSVGElement && !isSvgPart(el) && !isLocked(el)) {
    return { parent: el, index: srcOf.get(el)?.children.length ?? 0 };
  }
  const d = isSvgPart(el) ? drawingOf(el) : null;
  const parent = el.parentNode as SVGGraphicsElement | null;
  if (!d || isLocked(d) || !parent || !srcOf.has(parent)) return null;
  const src = srcOf.get(el)!;
  return { parent, index: Array.from(srcOf.get(parent)!.children).indexOf(src) + 1 };
}

/**
 * The ids of pasted elements that are taken in the page made new (`stroke-L` → `stroke-L-2`), and
 * the references inside the pasted elements to them (`url(#…)`, `href="#…"`) with them.
 */
function freshIds(roots: Element[]): void {
  const renamed = new Map<string, string>();
  const taken = (id: string) => !!document.getElementById(id) || Array.from(renamed.values()).includes(id);
  for (const r of roots) for (const el of [r, ...Array.from(r.querySelectorAll('[id]'))]) {
    const id = el.getAttribute('id');
    if (!id || !document.getElementById(id)) continue;
    const base = id.replace(/-\d+$/, '');
    let k = 2;
    while (taken(`${base}-${k}`)) k++;
    renamed.set(id, `${base}-${k}`);
    el.setAttribute('id', `${base}-${k}`);
  }
  if (!renamed.size) return;
  const swap = (name: string, v: string) => {
    const out = v.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (m, q: string, id: string) => (renamed.has(id) ? `url(${q}#${renamed.get(id)}${q})` : m));
    return /(^|:)href$/.test(name) ? out.replace(/^#(.+)$/, (m, id: string) => (renamed.has(id) ? `#${renamed.get(id)}` : m)) : out;
  };
  for (const r of roots) for (const el of [r, ...Array.from(r.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) { const v = swap(a.name, a.value); if (v !== a.value) el.setAttribute(a.name, v); }
  }
}

/** the same objects pasted again on the same slide: a step further each time */
let lastPaste: { body: string; slide: number; n: number } | null = null;

/** objects copied on a canvas (clipOf's html) pasted */
function pasteObjects(html: string, from: number, sel: Element[]): void {
  const body = html.replace(/<!--EndFragment-->[\s\S]*$/, '');
  const tmp = document.createElement('template');
  tmp.innerHTML = body;
  const items = Array.from(tmp.content.children);
  if (!items.length) return;
  const slide = pasteSlide(sel);
  const at = slide ? slides().indexOf(slide) : -1;
  lastPaste = lastPaste && lastPaste.body === body && lastPaste.slide === at ? { ...lastPaste, n: lastPaste.n + 1 } : { body, slide: at, n: 1 };
  // on the slide they came from: beside them, not on them
  const off = slide ? 24 * (lastPaste.n - (from === at && at >= 0 ? 0 : 1)) : 0;
  freshIds(items);
  const into = drawingTarget(sel, slide);
  const ops: HtmlOp[] = [];
  const select: Path[] = [];
  // parts of a drawing into the drawing selected: in its units, where they were on the slide
  const parts: string[] = [];
  const intoPath = into ? pathOf(into.parent) : null;
  const G = into && slide ? unitsToSlide(into.parent, slide) : null;
  const objects: string[] = [];
  for (const it of items) {
    const st = (it as HTMLElement).style;
    const box = ['left', 'top', 'width', 'height'].map(p => /^(-?[\d.]+)px$/.exec(st?.getPropertyValue(p) ?? '')?.[1]).map(Number);
    const vb = (it.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    if (it.getAttribute('data-ol-clip') === 'parts' && G && intoPath && box.every(Number.isFinite) && vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
      const F = new DOMMatrix().translate(box[0] + off, box[1] + off).scale(box[2] / vb[2], box[3] / vb[3]).translate(-vb[0], -vb[1]);
      const t = matrixText(G.inverse().multiply(F));
      for (const p of Array.from(it.children)) {
        if (t) p.setAttribute('transform', `${t} ${p.getAttribute('transform') ?? ''}`.trim());
        parts.push(p.outerHTML);
      }
      continue;
    }
    it.removeAttribute('data-ol-clip');
    if (off) for (const p of ['left', 'top']) { const v = st?.getPropertyValue(p); const m = v ? /^(-?[\d.]+)px$/.exec(v) : null; if (m) st.setProperty(p, `${Number(m[1]) + off}px`); }
    objects.push(it.outerHTML);
  }
  if (parts.length && into && intoPath) {
    ops.push({ t: 'insert', parent: intoPath, index: into.index, html: parts.join('\n') });
    for (let k = 0; k < parts.length; k++) select.push([...intoPath, into.index + k]);
  }
  const parent = slide ?? (sel[0]?.parentElement ?? document.body);
  const parentPath = parent ? pathOf(parent) : null;
  if (objects.length && parentPath) {
    const n = srcOf.get(parent)?.children.length ?? 0;
    ops.push({ t: 'insert', parent: parentPath, index: 1e6, html: objects.join('\n') });
    for (let k = 0; k < objects.length; k++) select.push([...parentPath, n + k]);
  }
  if (ops.length) commit(ops, { select });
}

/** a paste on the canvas: objects copied on a canvas, an SVG copied as text, else text as a new text box (files: the editor's) */
export function paste(d: { html: string; plain: string; files: { name: string; type: string; data: ArrayBuffer }[] }): void {
  if (state.version === null) return;
  const sel = selection();
  const slide = pasteSlide(sel);
  if (d.files.length) { post({ ol: 'pasteFiles', files: d.files, slide: slide ? pathOf(slide) : null, at: null }); return; }
  const m = MARK.exec(d.html);
  if (m) { pasteObjects(d.html.slice(m.index + m[0].length), Number(m[1] ?? -1), sel); return; }
  const plain = d.plain.trim();
  // an SVG copied as text (from Inkscape, a code editor): a drawing
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(plain)) {
    post({ ol: 'pasteFiles', files: [{ name: 'pasted.svg', type: 'image/svg+xml', data: new TextEncoder().encode(plain).buffer as ArrayBuffer }], slide: slide ? pathOf(slide) : null, at: null });
    return;
  }
  if (!plain) return;
  post({ ol: 'pasteText', version: state.version, slide: slide ? pathOf(slide) : null, after: sel.length === 1 && slideOf(sel[0]) === slide ? pathOf(sel[0]) : null, text: plain });
}
