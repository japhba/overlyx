/**
 * Other people's carets in a text they are retyping (edit.ts draws them, the editor passes them on
 * through the awareness). A caret travels as the path of the text box and offsets into its text —
 * offsets that mean the same on both sides although the box is drawn differently there: the one
 * retyping it has formula and citation chips (mathedit.ts), everyone else MathJax's output and
 * <ol-cite>s. So a formula, a reference, a citation, a picture or a line break counts as one place, a
 * block inside the box (a paragraph, a list item) one place where it starts, a character one, and
 * the runtime's own elements none.
 */

/** counted as one place, never looked into */
const ATOMS = 'mjx-container, ol-cite, .ol-mathchip, .ol-refchip, br, img, svg, video, audio, canvas, iframe, object, embed, picture, input, select, textarea, math';
/** a place where they start (as a line break would be) */
const BLOCKS = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'tr', 'td', 'th', 'section', 'article', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'header', 'footer', 'aside', 'caption']);
const SKIP = new Set(['script', 'style', 'template']);

type Tok = { kind: 'text'; node: Text } | { kind: 'atom' | 'block'; el: Element };

function tokens(root: Element): Tok[] {
  const out: Tok[] = [];
  const visit = (n: Node): void => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { out.push({ kind: 'text', node: c as Text }); continue; }
      if (c.nodeType !== 1) continue;
      const el = c as Element;
      if (el.hasAttribute('data-ol-runtime') || SKIP.has(el.localName)) continue;
      if (el.matches(ATOMS)) { out.push({ kind: 'atom', el }); continue; }
      if (BLOCKS.has(el.localName)) out.push({ kind: 'block', el });
      visit(el);
    }
  };
  visit(root);
  return out;
}

const lengthOf = (t: Tok): number => (t.kind === 'text' ? t.node.data.length : 1);
const indexIn = (n: Node): number => Array.prototype.indexOf.call(n.parentNode!.childNodes, n);

/** the place of a DOM point (a selection's anchor or focus) in `root`'s text */
export function offsetOf(root: Element, node: Node, offset: number): number {
  if (!root.contains(node)) return 0;
  const doc = root.ownerDocument;
  const at = doc.createRange();
  at.setStart(node, offset);
  let n = 0;
  for (const t of tokens(root)) {
    if (t.kind === 'text') {
      if (t.node === node) return n + Math.min(offset, t.node.data.length);
      // ends at or before the point: all of it before
      if (at.comparePoint(t.node, t.node.data.length) > 0) break;
      n += t.node.data.length;
    } else if (t.kind === 'block') {
      // the point is inside the block (or past it): its start is before
      if (at.comparePoint(t.el, 0) > 0) break;
      n += 1;
    } else {
      if (!t.el.parentNode || at.comparePoint(t.el.parentNode, indexIn(t.el) + 1) > 0) break;
      n += 1;
    }
  }
  return n;
}

/** the number of places in `root`'s text */
export function placesIn(root: Element): number {
  return tokens(root).reduce((n, t) => n + lengthOf(t), 0);
}

/** the DOM point at place `k` of `root`'s text (clamped): the end of a text rather than the start of the next */
export function pointAt(root: Element, k: number): { node: Node; offset: number } {
  const toks = tokens(root);
  let n = 0;
  k = Math.max(0, Math.floor(k));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'text') {
      if (k <= n + t.node.data.length) return { node: t.node, offset: k - n };
      n += t.node.data.length;
    } else if (t.kind === 'atom') {
      if (k <= n) return { node: t.el.parentNode!, offset: indexIn(t.el) };
      n += 1;
      if (k === n) {
        const next = toks[i + 1];
        if (!(next?.kind === 'text' && next.node.previousSibling === t.el)) return { node: t.el.parentNode!, offset: indexIn(t.el) + 1 };
      }
    } else {
      n += 1;
      // just inside a block with nothing in it that comes next
      if (k === n) {
        const next = toks[i + 1];
        const inside = next && t.el.contains(next.kind === 'text' ? next.node : next.el);
        if (!inside) return { node: t.el, offset: 0 };
      }
    }
  }
  return { node: root, offset: root.childNodes.length };
}

export interface CaretBox { x: number; top: number; h: number }
export interface SelBox { x: number; y: number; w: number; h: number }

const lastRect = (rs: DOMRectList | DOMRect[]): DOMRect | null => {
  for (let i = rs.length - 1; i >= 0; i--) if (rs[i].height > 0) return rs[i];
  return null;
};

/** where the caret at place `k` is drawn (client px): a line's height at the point */
export function caretBox(root: Element, k: number): CaretBox | null {
  const doc = root.ownerDocument;
  const p = pointAt(root, k);
  const r = doc.createRange();
  const edge = (q: DOMRect | null, right: boolean): CaretBox | null => (q ? { x: right ? q.right : q.left, top: q.top, h: q.height } : null);
  if (p.node.nodeType === 3) {
    const t = p.node as Text;
    // the character before (its right edge), else the one after (its left edge)
    if (p.offset > 0) { r.setStart(t, p.offset - 1); r.setEnd(t, p.offset); const b = edge(lastRect(r.getClientRects()), true); if (b) return b; }
    if (p.offset < t.data.length) { r.setStart(t, p.offset); r.setEnd(t, p.offset + 1); const b = edge(r.getClientRects()[0] ?? null, false); if (b && b.h > 0) return b; }
  } else {
    const kids = p.node.childNodes;
    const before = kids[p.offset - 1], after = kids[p.offset];
    const boxOfNode = (n: Node | undefined, right: boolean): CaretBox | null => {
      if (!n) return null;
      if (n.nodeType === 1) { const rs = (n as Element).getClientRects(); return edge(right ? lastRect(rs) : (Array.from(rs).find(q => q.height > 0) ?? null), right); }
      if (n.nodeType === 3 && (n as Text).data.length) {
        const t = n as Text;
        if (right) { r.setStart(t, t.data.length - 1); r.setEnd(t, t.data.length); } else { r.setStart(t, 0); r.setEnd(t, 1); }
        return edge(right ? lastRect(r.getClientRects()) : (r.getClientRects()[0] ?? null), right);
      }
      return null;
    };
    const b = boxOfNode(before, true) ?? boxOfNode(after, false);
    if (b) return b;
  }
  // an empty block (or box): the start of its first line
  const el = (p.node.nodeType === 1 ? p.node : p.node.parentElement) as Element | null;
  if (!el) return null;
  const b = el.getBoundingClientRect();
  if (!b.width && !b.height) return null;
  const cs = getComputedStyle(el);
  const fs = parseFloat(cs.fontSize) || 16;
  const lh = parseFloat(cs.lineHeight) || fs * 1.2;
  const align = cs.textAlign;
  const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
  const x = align === 'center' ? b.left + (b.width + pl - pr) / 2 : align === 'right' || align === 'end' ? b.right - pr : b.left + pl;
  return { x, top: b.top + (parseFloat(cs.paddingTop) || 0), h: Math.min(lh, Math.max(fs, b.height)) };
}

/** the boxes (client px) of the text between places `a` and `b` */
export function selectionBoxes(root: Element, a: number, b: number): SelBox[] {
  if (a === b) return [];
  const [from, to] = a < b ? [a, b] : [b, a];
  const p = pointAt(root, from), q = pointAt(root, to);
  const r = root.ownerDocument.createRange();
  try { r.setStart(p.node, p.offset); r.setEnd(q.node, q.offset); } catch { return []; }
  const out: SelBox[] = [];
  for (const x of Array.from(r.getClientRects())) {
    if (x.width < 0.5 || x.height < 0.5) continue;
    // (an element's box beside the boxes of its lines: only the lines)
    if (out.some(o => x.left <= o.x + 0.5 && x.top <= o.y + 0.5 && x.right >= o.x + o.w - 0.5 && x.bottom >= o.y + o.h - 0.5)) continue;
    out.push({ x: x.left, y: x.top, w: x.width, h: x.height });
  }
  return out;
}

/** a colour from another person's awareness, as CSS that cannot be more than a colour */
export function safeColor(c: unknown): string {
  return typeof c === 'string' && /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d.,%\s]+\))$/i.test(c.trim()) ? c.trim() : '#888';
}
