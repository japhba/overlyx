/**
 * LyX lengths ("100col%", "2.5cm", "1in") → LaTeX length strings, mirroring
 * src/support/Length.cpp::asLatexString.
 */

const PERCENT_UNITS: Record<string, string> = {
  'text%': '\\textwidth', 'col%': '\\columnwidth', 'page%': '\\paperwidth', 'line%': '\\linewidth',
  'theight%': '\\textheight', 'pheight%': '\\paperheight', 'baselineskip%': '\\baselineskip',
};

export interface ParsedLength { value: number; unit: string }

/** Parse a LyX length. Returns undefined for empty / unparsable input. */
export function parseLength(s: string | undefined): ParsedLength | undefined {
  if (!s) return undefined;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-zA-Z%]+)?\s*$/.exec(s);
  if (!m) return undefined;
  return { value: parseFloat(m[1]), unit: m[2] ?? '' };
}

/** Format a number without exponent and without trailing zeros (formatFPNumber). */
export function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  let s = v.toFixed(6);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** LyX length → LaTeX length ("50col%" → "0.5\columnwidth"). Non-lengths are returned as is. */
export function latexLength(s: string | undefined): string {
  if (!s) return '';
  const p = parseLength(s);
  if (!p) return s.trim();
  const rel = PERCENT_UNITS[p.unit];
  if (rel) return formatNumber(p.value / 100) + rel;
  if (!p.unit) return formatNumber(p.value);
  return formatNumber(p.value) + p.unit;
}

/** True when the length is zero / empty. */
export function isZeroLength(s: string | undefined): boolean {
  const p = parseLength(s);
  return !p || p.value === 0;
}
