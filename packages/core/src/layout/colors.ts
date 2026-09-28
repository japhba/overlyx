/**
 * LaTeX (xcolor) colours as CSS: the named colours of xcolor, dvipsnames and svgnames, the
 * document's own \definecolor / \colorlet, explicit models (`[HTML]D62728`, `[RGB]{2,61,107}`,
 * `{rgb,255:red,214;green,39;blue,40}`), and xcolor's mixing expressions (`jblue!25`,
 * `red!30!blue`, `-red`). What the editor draws layout objects and coloured text with.
 */
import NAMES from './xcolornames.json';

export type RGB = [number, number, number];

/** xcolor's base colours (and beamer's default structure colour) */
const BASE: Record<string, RGB> = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], cyan: [0, 1, 1], magenta: [1, 0, 1], yellow: [1, 1, 0],
  black: [0, 0, 0], white: [1, 1, 1], gray: [0.5, 0.5, 0.5], darkgray: [0.25, 0.25, 0.25], lightgray: [0.75, 0.75, 0.75],
  brown: [0.75, 0.5, 0.25], lime: [0.75, 1, 0], olive: [0.5, 0.5, 0], orange: [1, 0.5, 0], pink: [1, 0.75, 0.75],
  purple: [0.75, 0, 0.25], teal: [0, 0.5, 0.5], violet: [0.5, 0, 0.5],
  structure: [0.2, 0.2, 0.7], alerted: [1, 0, 0], example: [0, 0.5, 0],
};

const hex = (h: string): RGB | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};

/** A colour given in an explicit model (\definecolor{name}{model}{spec}). */
export function modelColor(model: string, spec: string): RGB | null {
  const nums = spec.split(/[\s,]+/).filter(Boolean).map(Number);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  switch (model.trim()) {
    case 'HTML': return hex(spec);
    case 'rgb': return nums.length === 3 && nums.every(Number.isFinite) ? nums.map(clamp) as RGB : null;
    case 'RGB': return nums.length === 3 && nums.every(Number.isFinite) ? nums.map(v => clamp(v / 255)) as RGB : null;
    case 'gray': return nums.length === 1 && Number.isFinite(nums[0]) ? [clamp(nums[0]), clamp(nums[0]), clamp(nums[0])] : null;
    case 'cmyk': {
      if (nums.length !== 4 || !nums.every(Number.isFinite)) return null;
      const [c, m, y, k] = nums;
      return [1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)];
    }
    case 'cmy': return nums.length === 3 ? nums.map(v => clamp(1 - v)) as RGB : null;
    case 'Gray': return nums.length === 1 ? [clamp(nums[0] / 15), clamp(nums[0] / 15), clamp(nums[0] / 15)] : null;
    default: return null;
  }
}

/** The colours a preamble defines: \definecolor{name}{model}{spec}, \colorlet{name}{expr}. */
export function preambleColors(preamble: string): Record<string, RGB> {
  const out: Record<string, RGB> = {};
  const re = /\\(definecolor|providecolor|colorlet)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}\s*(?:\{([^}]*)\}\s*\{([^}]*)\}|\{([^}]*)\})/g;
  for (const line of preamble.split('\n')) {
    const code = line.replace(/(^|[^\\])%.*$/, '$1');
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(code))) {
      const name = m[2].trim();
      const c = m[1] === 'colorlet' ? evalColor(m[5] ?? '', out) : m[3] !== undefined ? modelColor(m[3], m[4] ?? '') : null;
      if (c) out[name] = c;
    }
  }
  return out;
}

function named(name: string, doc: Record<string, RGB>): RGB | null {
  if (doc[name]) return doc[name];
  if (BASE[name]) return BASE[name];
  const d = (NAMES.dvips as Record<string, string>)[name] ?? (NAMES.svg as Record<string, string>)[name];
  return d ? hex(d) : null;
}

/**
 * Evaluate an xcolor expression: `name`, `name!pct`, `name!pct!name2!pct2…`, a leading `-` for
 * the complement, `[model]spec` (OverLyX's inline form), `rgb,255:red,214;green,39;blue,40`.
 */
export function evalColor(expr: string, doc: Record<string, RGB> = {}): RGB | null {
  let e = expr.trim().replace(/^\{([\s\S]*)\}$/, '$1').trim();
  if (!e) return null;
  const m = /^\[([A-Za-z]+)\]\s*\{?([^}]*)\}?$/.exec(e);
  if (m) return modelColor(m[1], m[2]);
  if (e.startsWith('#')) return hex(e);
  // extended expression: model,div:expr1,dec1;expr2,dec2;…
  const ext = /^(rgb|cmy|cmyk|hsb|gray|RGB|HTML)\s*,\s*([\d.]+)\s*:([\s\S]+)$/.exec(e);
  if (ext) {
    const div = Number(ext[2]);
    const acc: RGB = [0, 0, 0];
    for (const part of ext[3].split(';')) {
      const i = part.lastIndexOf(',');
      if (i < 0) return null;
      const c = evalColor(part.slice(0, i), doc), w = Number(part.slice(i + 1));
      if (!c || !Number.isFinite(w)) return null;
      for (let k = 0; k < 3; k++) acc[k] += c[k] * w;
    }
    return div ? acc.map(v => Math.min(1, Math.max(0, v / div))) as RGB : null;
  }
  let neg = false;
  if (e.startsWith('-')) { neg = true; e = e.slice(1); }
  const parts = e.split('!').map(x => x.trim());
  let cur = named(parts[0], doc);
  if (!cur) return null;
  for (let i = 1; i < parts.length; i += 2) {
    const pct = Number(parts[i]);
    if (!Number.isFinite(pct)) return null;
    const other = i + 1 < parts.length ? named(parts[i + 1], doc) : [1, 1, 1] as RGB;
    if (!other) return null;
    const p = Math.min(100, Math.max(0, pct)) / 100;
    cur = [0, 1, 2].map(k => cur![k] * p + other[k] * (1 - p)) as RGB;
  }
  return neg ? cur.map(v => 1 - v) as RGB : cur;
}

export function rgbToHex(c: RGB): string {
  return '#' + c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

/** An xcolor expression as a CSS colour (null when it cannot be evaluated). */
export function cssColor(expr: string | null | undefined, doc: Record<string, RGB> = {}): string | null {
  if (!expr) return null;
  const c = evalColor(expr, doc);
  return c ? rgbToHex(c) : null;
}

/** A CSS hex colour as the file writes it: `[HTML]D62728`. */
export function hexToTex(h: string): string {
  const c = hex(h);
  return c ? '[HTML]' + rgbToHex(c).slice(1).toUpperCase() : h;
}
