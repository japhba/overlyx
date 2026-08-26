/**
 * Loader for lib/unicodesymbols: maps Unicode code points to LaTeX text/math
 * commands and their package requirements (see src/Encoding.cpp).
 */
import { existsSync, readFileSync } from 'node:fs';

export interface UnicodeSymbol {
  code: number;
  textCommand: string;
  textPreamble: string;
  mathCommand: string;
  mathPreamble: string;
  flags: string[];
  /** unconditional force */
  force: boolean;
  /** force=enc1;enc2 */
  forceIn: string[];
  /** force!=enc1;enc2 */
  forceNotIn: string[];
  textNoTermination: boolean;
  mathalpha: boolean;
  combining: boolean;
}

export type UnicodeDB = Map<number, UnicodeSymbol>;

const cache = new Map<string, UnicodeDB>();

/** Unquote a C-style "..." string used in unicodesymbols. */
function unquoteC(s: string): string {
  return s.replace(/\\(["\\])/g, '$1');
}

function tokenizeSymbolLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#') break;
    if (c === '"') {
      let j = i + 1; let s = '';
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) { s += line[j] + line[j + 1]; j += 2; continue; }
        s += line[j]; j++;
      }
      out.push(unquoteC(s));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== ' ' && line[j] !== '\t') j++;
    out.push(line.slice(i, j));
    i = j;
  }
  return out;
}

export function loadUnicodeSymbols(file: string): UnicodeDB {
  const cached = cache.get(file);
  if (cached) return cached;
  const db: UnicodeDB = new Map();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const t = tokenizeSymbolLine(line);
      if (t.length < 4 || !t[0].startsWith('0x')) continue;
      const code = parseInt(t[0], 16);
      if (Number.isNaN(code)) continue;
      const flags = t[3] ? t[3].split(',').map(f => f.trim()).filter(Boolean) : [];
      const sym: UnicodeSymbol = {
        code, textCommand: t[1], textPreamble: t[2] ?? '', mathCommand: t[4] ?? '', mathPreamble: t[5] ?? '',
        flags, force: false, forceIn: [], forceNotIn: [], textNoTermination: false, mathalpha: false, combining: false,
      };
      let noterm: string | undefined;
      for (const f of flags) {
        if (f === 'force') sym.force = true;
        else if (f.startsWith('force!=')) sym.forceNotIn = f.slice(7).split(';');
        else if (f.startsWith('force=')) sym.forceIn = f.slice(6).split(';');
        else if (f.startsWith('notermination=')) noterm = f.slice(14);
        else if (f === 'mathalpha') sym.mathalpha = true;
        else if (f === 'combining') sym.combining = true;
      }
      if (noterm === 'text' || noterm === 'both') sym.textNoTermination = true;
      else if (noterm === 'none') sym.textNoTermination = false;
      else sym.textNoTermination = sym.textCommand.endsWith('}');
      db.set(code, sym);
    }
  }
  cache.set(file, db);
  return db;
}

/** Whether the symbol must be replaced by its command in the given LaTeX input encoding. */
export function isForced(sym: UnicodeSymbol, encoding: string): boolean {
  if (sym.force) return true;
  if (sym.forceIn.length && sym.forceIn.includes(encoding)) return true;
  if (sym.forceNotIn.length && !sym.forceNotIn.includes(encoding)) return true;
  return false;
}
