/**
 * Placeholder figures for the lorem-ipsum poster templates (symposium-posters.ts): bars, grouped and
 * horizontal bars, lines, a scatter with its fit, a heat map, a little flow diagram and an empty
 * picture frame, drawn as editable inline SVG that fills its box. Their numbers are made up by a
 * seeded generator and their labels are lorem ipsum — they stand where a poster's figures go, and say
 * nothing. Labels take the page's typeface and `ink` (white on a dark poster).
 */

export type LoremChartKind = 'bars' | 'grouped' | 'hbars' | 'lines' | 'scatter' | 'heatmap' | 'flow' | 'picture';
export interface LoremChartOptions {
  /** the series' colours (the first for single bars and the fit) */
  colours: string[];
  /** labels and axes */
  ink?: string;
  /** the labels' size on the page, px */
  text?: number;
  /** another seed, another made-up figure */
  seed?: number;
  /** how many bars / points / rows */
  n?: number;
  /** series (grouped bars, lines) */
  series?: number;
  /** a plot background (a light panel behind it, as some sources have) */
  panel?: string;
  /** the picture frame's / flow diagram's labels */
  label?: string;
  /** the series' legend (lines, grouped bars): shown unless false */
  legend?: boolean;
}

const f = (n: number) => +n.toFixed(1);
const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'elit', 'sed', 'tempor', 'magna', 'enim', 'minim', 'veniam', 'nostrud', 'ullamco', 'commodo', 'aute'];

/** a small seeded generator (mulberry32): the same figure every time */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A placeholder figure as an absolutely positioned inline SVG the size of its box (px). */
export function loremChart(kind: LoremChartKind, x: number, y: number, w: number, h: number, o: LoremChartOptions): string {
  const W = 600, H = Math.round(Math.max(.15, Math.min(4, h / w)) * W);
  const fs = f(Math.max(10, Math.min(34, (o.text ?? 20) * W / w)));
  const r = rng(o.seed ?? 7);
  const c = (i: number) => o.colours[i % o.colours.length];
  const label = (x: number, y: number, s: string, anchor = 'start', extra = '') => `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-size="${fs}" fill="currentColor"${extra}>${s}</text>`;
  let s = o.panel ? `<rect width="${W}" height="${H}" fill="${o.panel}"/>` : '';

  // a plot frame: left axis with three ticks, the bottom axis, the labels under it
  const frame = (left: number, top: number, right: number, bottom: number, xs: string[], ticks = ['0', '0.5', '1']) => {
    let a = '';
    ticks.forEach((t, i) => {
      const yy = bottom - (bottom - top) * i / (ticks.length - 1);
      a += `<line x1="${f(left)}" x2="${f(right)}" y1="${f(yy)}" y2="${f(yy)}" stroke="currentColor" stroke-opacity="${i ? .12 : .55}"/>`;
      a += label(left - fs * .4, yy + fs * .35, t, 'end', ' fill-opacity=".75"');
    });
    xs.forEach((t, i) => { a += label(left + (right - left) * (i + .5) / xs.length, bottom + fs * 1.3, t, 'middle', ' fill-opacity=".8"'); });
    a += `<line x1="${f(left)}" x2="${f(left)}" y1="${f(top)}" y2="${f(bottom)}" stroke="currentColor" stroke-opacity=".55"/>`;
    a += label(left - fs * 2.4, top - fs * .7, 'lorem ipsum', 'start', ' fill-opacity=".8"');
    return a;
  };
  const legend = (n: number, x0: number, y0: number) => {
    let a = '';
    for (let i = 0; i < n; i++) {
      a += `<rect x="${f(x0)}" y="${f(y0 + i * fs * 1.3 - fs * .75)}" width="${f(fs * .8)}" height="${f(fs * .8)}" fill="${c(i)}"/>`;
      a += label(x0 + fs * 1.2, y0 + i * fs * 1.3, WORDS[(i + 2) % WORDS.length]);
    }
    return a;
  };

  if (kind === 'bars' || kind === 'grouped') {
    const n = o.n ?? (kind === 'bars' ? 5 : 4), k = kind === 'bars' ? 1 : (o.series ?? 2);
    const left = fs * 2.8, right = W - fs * (k > 1 && o.legend !== false ? 5.5 : .8), top = fs * 1.8, bottom = H - fs * 2;
    s += frame(left, top, right, bottom, Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]));
    const slot = (right - left) / n, bw = slot * .72 / k;
    for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) {
      const v = .25 + .7 * r();
      const bx = left + slot * i + slot * .14 + j * bw, by = bottom - (bottom - top) * v;
      s += `<rect x="${f(bx)}" y="${f(by)}" width="${f(bw * .94)}" height="${f(bottom - by)}" fill="${c(k > 1 ? j : 0)}"/>`;
      if (k === 1) s += label(bx + bw * .47, by - fs * .35, v.toFixed(2), 'middle', ` font-size="${f(fs * .8)}"`);
    }
    if (k > 1 && o.legend !== false) s += legend(k, right + fs * .8, top + fs);
  } else if (kind === 'hbars') {
    const n = o.n ?? 5, left = fs * 5.2, right = W - fs * 2.2, top = fs * .6, bottom = H - fs * 1.6;
    const slot = (bottom - top) / n;
    for (let i = 0; i < n; i++) {
      const v = .15 + .85 * r(), yy = top + slot * i + slot * .18;
      s += label(left - fs * .4, yy + slot * .4, WORDS[(i + 3) % WORDS.length] + ' ' + WORDS[(i + 7) % WORDS.length], 'end');
      s += `<rect x="${f(left)}" y="${f(yy)}" width="${f((right - left) * v)}" height="${f(slot * .6)}" fill="${c(i === 0 ? 0 : 1)}"/>`;
      s += label(left + (right - left) * v + fs * .3, yy + slot * .45, `${Math.round(v * 100)}%`, 'start', ` font-size="${f(fs * .85)}"`);
    }
    s += `<line x1="${f(left)}" x2="${f(left)}" y1="${f(top)}" y2="${f(bottom)}" stroke="currentColor" stroke-opacity=".55"/>`;
  } else if (kind === 'lines' || kind === 'scatter') {
    const left = fs * 2.8, right = W - fs * (kind === 'lines' && o.legend !== false ? 5.2 : 1), top = fs * 1.8, bottom = H - fs * 2.2;
    s += frame(left, top, right, bottom, ['0', '25', '50', '75', '100'].map(String));
    const X = (t: number) => left + (right - left) * t, Y = (v: number) => bottom - (bottom - top) * v;
    if (kind === 'lines') {
      const k = o.series ?? 3, n = o.n ?? 8;
      for (let j = 0; j < k; j++) {
        const a = .15 + .2 * r(), b = .3 + .4 * r();
        const pts = Array.from({ length: n }, (_, i) => { const t = i / (n - 1); return [X(t), Y(Math.min(.97, a + b * (1 - Math.exp(-3 * t)) + .06 * (r() - .5)))] as const; });
        s += `<polyline points="${pts.map(p => p.map(f).join(',')).join(' ')}" fill="none" stroke="${c(j)}" stroke-width="${f(fs * .2)}" stroke-linejoin="round"/>`;
        for (const [px, py] of pts) s += `<circle cx="${f(px)}" cy="${f(py)}" r="${f(fs * .28)}" fill="${c(j)}"/>`;
      }
      if (o.legend !== false) s += legend(k, right + fs * .8, top + fs);
    } else {
      const n = o.n ?? 28;
      for (let i = 0; i < n; i++) {
        const t = r(), v = Math.max(.03, Math.min(.97, .15 + .7 * t + .22 * (r() - .5)));
        s += `<circle cx="${f(X(t))}" cy="${f(Y(v))}" r="${f(fs * .32)}" fill="${c(1 + (i % Math.max(1, o.colours.length - 1)))}" fill-opacity=".9"/>`;
      }
      s += `<line x1="${f(X(0))}" y1="${f(Y(.15))}" x2="${f(X(1))}" y2="${f(Y(.85))}" stroke="${c(0)}" stroke-width="${f(fs * .16)}"/>`;
      s += label(right - fs * .3, bottom - fs * .8, 'lorem = 0.40', 'end', ' font-weight="700"');
    }
  } else if (kind === 'heatmap') {
    const rows = o.n ?? 6, cols = o.series ?? 12;
    const left = fs * 4.2, right = W - fs * .4, top = fs * 1.6, bottom = H - fs * .4;
    const cw = (right - left) / cols, ch = (bottom - top) / rows;
    const [lo, hi] = [o.colours[0], o.colours[1] ?? o.colours[0]];
    for (let j = 0; j < cols; j++) s += label(left + cw * (j + .5), top - fs * .4, WORDS[j % WORDS.length].slice(0, 4), 'middle', ` font-size="${f(fs * .7)}" fill-opacity=".75"`);
    for (let i = 0; i < rows; i++) {
      s += label(left - fs * .3, top + ch * (i + .6), WORDS[(i + 5) % WORDS.length], 'end', ` font-size="${f(fs * .8)}"`);
      for (let j = 0; j < cols; j++) {
        const v = r(), col = v < .5 ? lo : hi, op = Math.abs(v - .5) * 1.8;
        s += `<rect x="${f(left + cw * j)}" y="${f(top + ch * i)}" width="${f(cw - 1.5)}" height="${f(ch - 1.5)}" fill="${col}" fill-opacity="${op.toFixed(2)}"/>`;
        if (ch > fs * 1.1) s += label(left + cw * (j + .5), top + ch * (i + .62), (.3 + .6 * v).toFixed(2), 'middle', ` font-size="${f(Math.min(fs * .7, cw * .32))}"`);
      }
    }
  } else if (kind === 'flow') {
    // three steps joined by arrows, a fourth beneath the last: a placeholder for a method diagram
    const bw = W * .24, bh = Math.min(H * .32, fs * 3.4), gap = (W - 3 * bw) / 4, yy = H * .14;
    const box = (bx: number, by: number, t: string, fill: string, ink: string) =>
      `<rect x="${f(bx)}" y="${f(by)}" width="${f(bw)}" height="${f(bh)}" rx="${f(fs * .5)}" fill="${fill}" stroke="${c(0)}" stroke-width="${f(fs * .12)}"/>` + `<text x="${f(bx + bw / 2)}" y="${f(by + bh / 2 + fs * .35)}" text-anchor="middle" font-size="${fs}" fill="${ink}">${t}</text>`;
    const arrow = (x1: number, y1: number, x2: number, y2: number) => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="currentColor" stroke-width="${f(fs * .12)}" marker-end="url(#lorem-arrow)"/>`;
    s += `<defs><marker id="lorem-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${f(fs * .35)}" markerHeight="${f(fs * .35)}" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>`;
    const labels = (o.label ?? 'Lorem|Ipsum|Dolor|Sit amet').split('|');
    for (let i = 0; i < 3; i++) {
      const bx = gap + i * (bw + gap);
      s += box(bx, yy, labels[i] ?? WORDS[i], i === 1 ? c(0) : 'none', i === 1 ? '#ffffff' : 'currentColor');
      if (i < 2) s += arrow(bx + bw + fs * .2, yy + bh / 2, bx + bw + gap - fs * .3, yy + bh / 2);
    }
    const bx = gap + 2 * (bw + gap), by = Math.max(yy + bh + fs * 2, H - bh - fs * .6);
    s += arrow(bx + bw / 2, yy + bh + fs * .2, bx + bw / 2, by - fs * .3) + box(bx, by, labels[3] ?? WORDS[3], 'none', 'currentColor');
    s += `<text x="${f(gap)}" y="${f(by + bh / 2 + fs * .35)}" font-size="${f(fs * .85)}" fill="currentColor" fill-opacity=".7">${WORDS[(o.seed ?? 3) % WORDS.length]} ipsum dolor sit amet</text>`;
  } else {
    // a picture's frame: dashed, with a mountain and a sun
    const m = Math.min(W, H);
    s += `<rect x="${f(fs * .3)}" y="${f(fs * .3)}" width="${f(W - fs * .6)}" height="${f(H - fs * .6)}" rx="${f(fs * .6)}" fill="none" stroke="${c(0)}" stroke-width="${f(fs * .14)}" stroke-dasharray="${f(fs * .6)} ${f(fs * .45)}"/>`;
    const cx = W / 2, cy = H / 2 - fs * .4, k = m * .18;
    s += `<path d="M${f(cx - k * 1.3)} ${f(cy + k * .7)}L${f(cx - k * .3)} ${f(cy - k * .4)}L${f(cx + k * .25)} ${f(cy + k * .25)}L${f(cx + k * .6)} ${f(cy - k * .1)}L${f(cx + k * 1.3)} ${f(cy + k * .7)}Z" fill="${c(0)}" fill-opacity=".35"/>`;
    s += `<circle cx="${f(cx + k * .7)}" cy="${f(cy - k * .65)}" r="${f(k * .22)}" fill="${c(0)}" fill-opacity=".35"/>`;
    s += `<text x="${f(cx)}" y="${f(cy + k * .7 + fs * 1.6)}" text-anchor="middle" font-size="${fs}" fill="currentColor" fill-opacity=".7">${o.label ?? 'Figure'}</text>`;
  }
  const what = kind === 'picture' ? 'Picture placeholder' : kind === 'flow' ? 'Placeholder diagram' : `Placeholder ${kind === 'hbars' ? 'bar' : kind} chart`;
  return `  <svg role="img" aria-label="${what}: made-up values, lorem ipsum labels" viewBox="0 0 ${W} ${H}" style="position: absolute; left: ${f(x)}px; top: ${f(y)}px; width: ${f(w)}px; height: ${f(h)}px; overflow: visible${o.ink ? `; color: ${o.ink}` : ''}">${s}</svg>`;
}
