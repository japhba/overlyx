/**
 * The check of layout text boxes against the PDF. On every build the layout macros (latex.ts) write
 * `<job>.olx`: the class's display and list spacing once, and per text box (on every slide) its
 * geometry, the natural height of its text as TeX set it, the box's inner height and the
 * baselineskip in it:
 *
 *   olx params above=11.0pt ashort=0.0pt below=11.0pt bshort=6.5pt leftmargin=21.90005pt labelsep=5.475pt itemsep=3.0pt
 *   olx box 1 1 x=30mm y=26mm w=610mm h=70mm natural=169.96747pt inner=199.16928pt baselineskip=99.44043pt
 *
 * `layoutCheck` pairs the records with the boxes of the document as it was built and as it is now: a
 * box counts as `fresh` when its source is unchanged since the build, so the editor compares only
 * those with what it shows (a box is found by its page and its geometry).
 */

/** the class's spacing as TeX used it, in pt */
export interface OlxParams { above: number; ashort: number; below: number; bshort: number; leftmargin: number; labelsep: number; itemsep: number }

/** a text box as TeX set it: `frame` 1-based, geometry in mm, heights in pt */
export interface OlxBox { frame: number; slide: number; x: number; y: number; w: number; h: number; natural: number; inner: number; baselineskip: number }

/** the check of one box of the document: `page` 0-based, `key` its geometry (and which of equal ones), heights in pt */
export interface LayoutCheckBox { page: number; key: string; natural: number; inner: number; baselineskip: number; fresh: boolean }
export interface LayoutCheck { params: OlxParams | null; boxes: LayoutCheckBox[] }

const PT_PER_UNIT: Record<string, number> = { pt: 1, mm: 72.27 / 25.4, cm: 72.27 / 2.54, in: 72.27, bp: 72.27 / 72, sp: 1 / 65536 };

/** a TeX length ("30mm", "169.9pt") in pt; NaN when it is not one */
export function texLengthPt(s: string): number {
  const m = /^\s*(-?\d*\.?\d+)\s*(pt|mm|cm|in|bp|sp)\s*$/.exec(s);
  return m ? Number(m[1]) * PT_PER_UNIT[m[2]] : NaN;
}
const toMm = (s: string) => Math.round(texLengthPt(s) * 25.4 / 72.27 * 1e4) / 1e4;

/** the key of a box's geometry (mm, to 0.1 mm), as the editor computes it from a node's attributes */
export function boxKey(x: number, y: number, w: number, h: number): string {
  return [x, y, w, h].map(v => (Math.round(v * 10) / 10).toFixed(1)).join(',');
}

export function parseOlx(text: string): { params: OlxParams | null; boxes: OlxBox[] } {
  let params: OlxParams | null = null;
  const boxes: OlxBox[] = [];
  for (const line of text.split(/\r?\n/)) {
    const kv = (name: string) => new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(line)?.[1] ?? '';
    if (line.startsWith('olx params ')) {
      const p = { above: texLengthPt(kv('above')), ashort: texLengthPt(kv('ashort')), below: texLengthPt(kv('below')), bshort: texLengthPt(kv('bshort')), leftmargin: texLengthPt(kv('leftmargin')), labelsep: texLengthPt(kv('labelsep')), itemsep: texLengthPt(kv('itemsep')) };
      if (Object.values(p).every(Number.isFinite)) params = p;
    } else if (line.startsWith('olx box ')) {
      const m = /^olx box (\d+) (\d+) /.exec(line);
      const b = { frame: Number(m?.[1]), slide: Number(m?.[2]), x: toMm(kv('x')), y: toMm(kv('y')), w: toMm(kv('w')), h: toMm(kv('h')), natural: texLengthPt(kv('natural')), inner: texLengthPt(kv('inner')), baselineskip: texLengthPt(kv('baselineskip')) };
      if (m && Object.values(b).every(Number.isFinite)) boxes.push(b);
    }
  }
  return { params, boxes };
}

/** the text boxes of each frame of a layout document's source: their geometry key and their whole source */
export function olboxBlocks(tex: string): { key: string; source: string }[][] {
  const frames: { key: string; source: string }[][] = [];
  const src = tex.replace(/(^|[^\\])%.*$/gm, '$1');
  for (const fm of src.matchAll(/\\begin\{frame\}([\s\S]*?)\\end\{frame\}/g)) {
    const blocks: { key: string; source: string }[] = [];
    const seen = new Map<string, number>();
    for (const bm of fm[1].matchAll(/\\begin\{olbox\}\{((?:[^{}]|\{[^{}]*\})*)\}([\s\S]*?)\\end\{olbox\}/g)) {
      const opt = (name: string) => new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*([^,]+)`).exec(bm[1])?.[1]?.trim() ?? '';
      const geo = boxKey(toMm(opt('x')), toMm(opt('y')), toMm(opt('w')), toMm(opt('h')));
      const n = seen.get(geo) ?? 0;
      seen.set(geo, n + 1);
      blocks.push({ key: `${geo}#${n}`, source: bm[0] });
    }
    frames.push(blocks);
  }
  return frames;
}

/**
 * The records of a build (`olx`) for the document now (`liveTex`), given the source that was built
 * (`builtTex`). Boxes are identified by frame and geometry (the n-th of equal ones in the frame, on the
 * slide where it was set first); each keeps the first slide's record.
 */
export function layoutCheck(olx: string, builtTex: string, liveTex: string): LayoutCheck {
  const { params, boxes } = parseOlx(olx);
  const built = olboxBlocks(builtTex), live = olboxBlocks(liveTex);
  const out: LayoutCheckBox[] = [];
  const taken = new Set<string>();
  // occurrence numbers per slide, as olboxBlocks counts them per frame
  const count = new Map<string, number>();
  for (const b of boxes) {
    const geo = boxKey(b.x, b.y, b.w, b.h);
    const slideKey = `${b.frame}/${b.slide}/${geo}`;
    const n = count.get(slideKey) ?? 0;
    count.set(slideKey, n + 1);
    const key = `${geo}#${n}`;
    const page = b.frame - 1;
    if (taken.has(`${page}|${key}`)) continue;
    const src = built[page]?.find(x => x.key === key);
    if (!src) continue;
    taken.add(`${page}|${key}`);
    const now = live[page]?.find(x => x.key === key);
    out.push({ page, key, natural: b.natural, inner: b.inner, baselineskip: b.baselineskip, fresh: !!now && now.source === src.source });
  }
  return { params, boxes: out };
}
