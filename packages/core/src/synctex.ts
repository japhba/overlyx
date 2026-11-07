/**
 * SyncTeX's two searches on a .synctex file's text (gunzipped), for builds that have no `synctex`
 * program at hand: the PDF builds of end-to-end encrypted projects, made in the browser. The server
 * runs `synctex view` / `synctex edit` itself (server export.ts); these give the same shapes, in
 * PDF points (bp) from the page's top-left corner.
 *
 *   synctexView  the boxes of the PDF that line `line` of the built .tex went into (forward search)
 *   synctexEdit  the source line under a point of a page (inverse search)
 */

/** A box in the PDF (points, origin at the page's top-left): `x`/`y` its reference point, `h`/`v` the left/bottom of the box, `W`/`H` its width and height. */
export interface SyncBox { page: number; x: number; y: number; h: number; v: number; W: number; H: number }

interface HBox { tag: number; line: number; h: number; v: number; W: number; H: number; D: number; records: { tag: number; line: number; h: number }[] }
interface Parsed { inputs: Map<number, string>; pages: Map<number, HBox[]> }

/** sp → bp: SyncTeX's unit and the magnification as the file states them */
function parse(text: string): Parsed {
  const lines = text.split('\n');
  const inputs = new Map<number, string>();
  let i = 0, unit = 1, mag = 1000, xoff = 0, yoff = 0;
  for (; i < lines.length && lines[i] !== 'Content:'; i++) {
    const l = lines[i];
    let m = /^Input:(\d+):(.*)$/.exec(l);
    if (m) { inputs.set(Number(m[1]), m[2].trim()); continue; }
    if ((m = /^Unit:(\d+)/.exec(l))) unit = Number(m[1]) || 1;
    else if ((m = /^Magnification:(\d+)/.exec(l))) mag = Number(m[1]) || 1000;
    else if ((m = /^X Offset:(-?\d+)/.exec(l))) xoff = Number(m[1]);
    else if ((m = /^Y Offset:(-?\d+)/.exec(l))) yoff = Number(m[1]);
  }
  const bp = (sp: number) => sp * unit * (mag / 1000) / 65781.76;
  const pages = new Map<number, HBox[]>();
  let page = 0, boxes: HBox[] = [];
  const stack: (HBox | null)[] = [];
  const RE = /^([[(vhxkg$r])(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l[0];
    if (c === '{') { page = Number(l.slice(1)); boxes = []; stack.length = 0; continue; }
    if (c === '}') { if (page) pages.set(page, boxes); page = 0; continue; }
    if (!page) continue;
    if (c === ']' || c === ')') { stack.pop(); continue; }
    if (c === 'I' || c === '!') continue;
    const m = RE.exec(l);
    if (!m) continue;
    const tag = Number(m[2]), line = Number(m[3]);
    const h = bp(Number(m[4]) + xoff), v = bp(Number(m[5]) + yoff);
    if (m[1] === '(' || m[1] === 'h') {
      const b: HBox = { tag, line, h, v, W: bp(Number(m[6] ?? 0)), H: bp(Number(m[7] ?? 0)), D: bp(Number(m[8] ?? 0)), records: [] };
      boxes.push(b);
      if (m[1] === '(') stack.push(b);
      continue;
    }
    if (m[1] === '[') { stack.push(null); continue; }
    if (m[1] === 'v') continue;
    // a glyph position, kern, glue, formula or rule: it belongs to the innermost horizontal box
    for (let k = stack.length - 1; k >= 0; k--) { const b = stack[k]; if (b) { b.records.push({ tag, line, h }); break; } }
  }
  return { inputs, pages };
}

/** the input tag of `name` (the built .tex's file name, as given or as a path ending in it) */
function tagOf(p: Parsed, name: string): number | null {
  for (const [t, path] of p.inputs) if (path === name || path.endsWith('/' + name)) return t;
  return null;
}

/**
 * Forward search: where line `line` (1-based) of the input `name` went in the PDF — the horizontal
 * boxes holding its material, one per page and line of the PDF. A line that left nothing in the PDF
 * (a comment, a blank line) gives the next line that did, as `synctex view` does.
 */
export function synctexView(text: string, name: string, line: number): SyncBox[] {
  const p = parse(text);
  const tag = tagOf(p, name);
  if (tag === null) return [];
  const find = (want: number): SyncBox[] => {
    const out: SyncBox[] = [];
    for (const [page, boxes] of p.pages) {
      for (const b of boxes) {
        const own = b.tag === tag && b.line === want;
        const rec = b.records.find(r => r.tag === tag && r.line === want);
        if (!own && !rec) continue;
        // (a box whose lines are other boxes holds the line only through them: those are reported)
        if (!rec && boxes.some(o => o !== b && o.records.some(r => r.tag === tag && r.line === want) && o.h >= b.h && o.v <= b.v + b.D && o.v >= b.v - b.H)) continue;
        out.push({ page, x: rec ? rec.h : b.h, y: b.v, h: b.h, v: b.v + b.D, W: b.W, H: b.H + b.D });
      }
    }
    return out.sort((a, b) => a.page - b.page || a.y - b.y || a.h - b.h);
  };
  for (let d = 0; d < 20; d++) {
    const r = find(line + d);
    if (r.length) return r;
  }
  return [];
}

/** Inverse search: the source line under a point of page `page` (`x`/`y` in points from the page's top-left). */
export function synctexEdit(text: string, page: number, x: number, y: number): { file: string; line: number; column: number } | null {
  const p = parse(text);
  const boxes = p.pages.get(page);
  if (!boxes?.length) return null;
  // the smallest box around the point, else the box nearest to it (above or below a line, in a margin)
  const dist = (b: HBox) => {
    const dx = x < b.h ? b.h - x : x > b.h + b.W ? x - b.h - b.W : 0;
    const dy = y < b.v - b.H ? b.v - b.H - y : y > b.v + b.D ? y - b.v - b.D : 0;
    return dx + dy * 4;
  };
  const withRecords = boxes.filter(b => b.records.length || b.line > 0);
  if (!withRecords.length) return null;
  const best = withRecords.reduce((a, b) => {
    const da = dist(a), db = dist(b);
    if (da !== db) return db < da ? b : a;
    return b.W * (b.H + b.D) < a.W * (a.H + a.D) ? b : a;
  });
  // in the box, the material nearest left of the point (what was typeset there), else the box's own line
  let tag = best.tag, line = best.line;
  const left = best.records.filter(r => r.h <= x + 0.5 && r.line > 0).sort((a, b) => b.h - a.h)[0] ?? best.records.find(r => r.line > 0);
  if (left) { tag = left.tag; line = left.line; }
  const file = p.inputs.get(tag);
  if (!file || line < 1) return null;
  return { file: file.split('/').pop()!, line, column: -1 };
}
