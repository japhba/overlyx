/**
 * Backgrounds of slides and posters, and gradient fills of shapes (BackgroundPicker.tsx): a colour,
 * a gradient (linear at an angle, or radial; two or more stops) or a picture (fill / fit / tile,
 * dimmed towards white or black so text stays readable) — all of it plain CSS in the slide's own
 * `style`, readable and shown without OverLyX (presenting, PDF, the website zip):
 *
 *   background: linear-gradient(135deg, #1a73e8 0%, #9334e6 100%)
 *   background: radial-gradient(circle, #ffffff 0%, #c9d7f8 100%)
 *   background: linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url('images/hall.jpg') center / cover no-repeat
 *
 * (the first layer of a picture is its dimming; `#ffffff` what shows around a fitted one). bgCss
 * writes these, parseBg reads them back for the picker — anything else written by hand is "custom"
 * and left alone until another background is chosen.
 */

export interface Stop { color: string; at: number }
export type Fit = 'fill' | 'fit' | 'tile';
export type Bg =
  | { kind: 'none' }
  | { kind: 'color'; color: string }
  | { kind: 'gradient'; shape: 'linear' | 'radial'; angle: number; stops: Stop[] }
  | { kind: 'picture'; src: string; fit: Fit; dim: number; dimTo: 'white' | 'black' }
  | { kind: 'custom'; css: string };

const r = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${r(Math.max(0, Math.min(100, n)))}%`;

/** the stops of a gradient, in order of position */
const stopList = (stops: Stop[]) => stops.slice().sort((a, b) => a.at - b.at).map(s => `${s.color} ${pct(s.at)}`).join(', ');

/** a gradient as a CSS image (also what a shape's fill takes) */
export function gradientCss(shape: 'linear' | 'radial', angle: number, stops: Stop[]): string {
  return shape === 'radial' ? `radial-gradient(circle, ${stopList(stops)})` : `linear-gradient(${Math.round(((angle % 360) + 360) % 360)}deg, ${stopList(stops)})`;
}

// (single quotes: the style attribute is written in double ones)
const urlCss = (src: string) => `url('${src.replace(/['\\\n]/g, c => (c === '\n' ? '' : '\\' + c))}')`;

/** the `background` value for a choice; null: as the design has it (the slide's own background removed) */
export function bgCss(b: Bg): string | null {
  switch (b.kind) {
    case 'none': return null;
    case 'color': return b.color;
    case 'custom': return b.css;
    case 'gradient': return b.stops.length >= 2 ? gradientCss(b.shape, b.angle, b.stops) : b.stops[0]?.color ?? null;
    case 'picture': {
      const place = b.fit === 'tile' ? 'top left / auto repeat' : `center / ${b.fit === 'fit' ? 'contain' : 'cover'} no-repeat`;
      const a = r(Math.max(0, Math.min(0.9, b.dim)));
      const veil = a > 0 ? `linear-gradient(${b.dimTo === 'black' ? `rgba(0, 0, 0, ${a})` : `rgba(255, 255, 255, ${a})`}, ${b.dimTo === 'black' ? `rgba(0, 0, 0, ${a})` : `rgba(255, 255, 255, ${a})`}), ` : '';
      return `${veil}${urlCss(b.src)} ${place} ${b.fit === 'fit' ? (b.dimTo === 'black' && a > 0 ? '#000000' : '#ffffff') : ''}`.trim();
    }
  }
}

/** split at top-level commas (not those inside parentheses) */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$/i;

function parseGradient(css: string): Extract<Bg, { kind: 'gradient' }> | null {
  const m = /^(linear|radial)-gradient\((.*)\)$/i.exec(css.trim());
  if (!m) return null;
  const parts = splitTop(m[2]);
  let angle = 180, shape = m[1].toLowerCase() as 'linear' | 'radial';
  if (shape === 'linear') {
    const a = /^(-?[\d.]+)deg$/.exec(parts[0]);
    const to: Record<string, number> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to bottom right': 135, 'to bottom left': 225, 'to top left': 315 };
    if (a) { angle = Number(a[1]); parts.shift(); } else if (parts[0] in to) { angle = to[parts[0]]; parts.shift(); }
  } else if (/^(circle|ellipse)/.test(parts[0]) || /\bat\b/.test(parts[0])) parts.shift();
  const stops: Stop[] = [];
  parts.forEach((p, i) => {
    const s = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(p)!;
    if (!COLOR.test(s[1].trim())) return;
    stops.push({ color: s[1].trim(), at: s[2] !== undefined ? Number(s[2]) : parts.length > 1 ? (i / (parts.length - 1)) * 100 : 0 });
  });
  return stops.length >= 2 ? { kind: 'gradient', shape, angle, stops } : null;
}

/** what the picker shows for a `background` written in the source (null / '': none of its own) */
export function parseBg(css: string | null | undefined): Bg {
  const v = (css ?? '').trim();
  if (!v) return { kind: 'none' };
  if (COLOR.test(v) && !/^(none|transparent|inherit|initial|unset)$/i.test(v)) return { kind: 'color', color: v };
  const g = parseGradient(v);
  if (g) return g;
  const layers = splitTop(v);
  const pic = layers[layers.length - 1];
  const u = /url\(\s*(["']?)(.*?)\1\s*\)/.exec(pic);
  if (u && layers.length <= 2) {
    let dim = 0, dimTo: 'white' | 'black' = 'white';
    if (layers.length === 2) {
      const veil = /^linear-gradient\(\s*rgba\(\s*(\d+),\s*\d+,\s*\d+,\s*([\d.]+)\)/.exec(layers[0]);
      if (!veil) return { kind: 'custom', css: v };
      dim = Number(veil[2]); dimTo = veil[1] === '0' ? 'black' : 'white';
    }
    const fit: Fit = /\brepeat\b(?!-)/.test(pic) && !/no-repeat/.test(pic) ? 'tile' : /\bcontain\b/.test(pic) ? 'fit' : 'fill';
    return { kind: 'picture', src: u[2].replace(/\\(.)/g, '$1'), fit, dim, dimTo };
  }
  return { kind: 'custom', css: v };
}

/** the background a slide's style attribute gives itself (its `background`, else `background-color` / `-image`) */
export function bgOfStyle(style: string): string | null {
  const decl = (p: string) => { const m = new RegExp(`(?:^|;)\\s*${p}\\s*:\\s*([^;]*(?:\\([^)]*\\)[^;]*)*)`, 'i').exec(style); return m ? m[1].trim() : null; };
  return decl('background') ?? decl('background-image') ?? decl('background-color');
}

/** the style declarations a background choice writes (the longhands that would fight it removed) */
export const bgStyle = (css: string | null): Record<string, string | null> => ({ background: css, 'background-color': null, 'background-image': null, 'background-size': null, 'background-position': null, 'background-repeat': null });

/** the picture files the deck already uses (its <img> and background addresses): offered first in the picker */
export function picturesIn(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/<img\b[^>]*?\bsrc\s*=\s*"([^"]+)"/gi)) if (!/^(data:|https?:)/i.test(m[1])) out.add(m[1]);
  for (const m of source.matchAll(/url\(\s*(?:&quot;|["'])?([^"'()&]+?)(?:&quot;|["'])?\s*\)/gi)) if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(m[1]) && !/^(data:|https?:)/i.test(m[1])) out.add(m[1]);
  return [...out].slice(0, 24);
}

/**
 * A CSS gradient as an SVG paint server, for the shapes of a drawing (an SVG fill cannot be a CSS
 * gradient): `<linearGradient id="…" gradientTransform="rotate(…)">` with its stops, the angle
 * turned about the shape's middle as CSS does (0° up, 90° to the right). Null: not a gradient.
 */
export function svgGradient(css: string, id: string): string | null {
  const g = parseGradient(css);
  if (!g) return null;
  const stops = g.stops.slice().sort((a, b) => a.at - b.at).map(s => `<stop offset="${pct(s.at)}" stop-color="${s.color}"/>`).join('');
  return g.shape === 'radial'
    ? `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`
    : `<linearGradient id="${id}" gradientTransform="rotate(${r(g.angle - 90)} 0.5 0.5)">${stops}</linearGradient>`;
}

export const isGradient = (css: string | null | undefined): boolean => !!css && /^\s*(linear|radial)-gradient\(/i.test(css);
