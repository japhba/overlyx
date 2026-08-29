/**
 * Words worth spell-checking in a paragraph: the text of ordinary prose, leaving out what a LaTeX
 * author does not want underlined — formulas, commands, references, citation keys, code (ERT,
 * listings, typewriter text), text marked "no spellcheck" in LyX, acronyms and identifiers.
 */
import type { Node as PMNode } from 'prosemirror-model';

export interface Word { word: string; from: number; to: number }

/** insets whose text is code / markup, not prose */
export const NO_SPELL_INSETS = new Set(['ERT', 'listings', 'Preamble', 'Index', 'IPA', 'Argument', 'Label', 'Flex Code', 'Flex URL', 'Flex Filename']);
export const NO_SPELL_LAYOUTS = new Set(['LyX-Code', 'Verbatim', 'Verbatim*', 'Bibliography', 'Title', 'Author']);

const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
/** whitespace-delimited tokens that are not prose: e-mail addresses, URLs, paths, file names, versions, identifiers with digits */
const NOT_PROSE_TOKEN = /[@\\/_]|\d|\p{L}\.\p{L}/u;
/** Latin and other abbreviations that every paper uses */
const ABBREVIATIONS = new Set(['et', 'al', 'cf', 'vs', 'resp', 'etc', 'viz', 'ibid', 'ca', 'eq', 'eqs', 'fig', 'figs', 'sec', 'secs', 'ref', 'refs', 'th', 'st', 'nd', 'rd']);

/** true when the word is prose (not an acronym, identifier, single letter, or something with a capital inside) */
export function isProseWord(w: string): boolean {
  if (w.length < 2) return false;
  if (ABBREVIATIONS.has(w.toLowerCase())) return false;
  if ((w.match(/\p{Lu}/gu) ?? []).length >= 2) return false;                // acronyms and their plurals (RNN, DNNs, GPs)
  if (/\p{Ll}\p{Lu}/u.test(w)) return false;                               // camelCase identifiers
  return true;
}

/** Words of a text block whose start is at `base` (positions are absolute document positions). */
export function wordsOf(par: PMNode, base: number): Word[] {
  const out: Word[] = [];
  if (NO_SPELL_LAYOUTS.has(String(par.attrs.layout))) return out;
  par.forEach((child, offset) => {
    if (!child.isText || !child.text) return;
    if (child.marks.some(m => m.type.name === 'nospellcheck' || (m.type.name === 'family' && m.attrs.value === 'typewriter'))) return;
    const start = base + 1 + offset;
    // token by token (whitespace-delimited), so that an e-mail address or a URL is skipped as a whole
    const TOKEN = /\S+/g;
    let t: RegExpExecArray | null;
    while ((t = TOKEN.exec(child.text))) {
      if (NOT_PROSE_TOKEN.test(t[0])) continue;
      WORD.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WORD.exec(t[0]))) {
        if (!isProseWord(m[0])) continue;
        out.push({ word: m[0], from: start + t.index + m.index, to: start + t.index + m.index + m[0].length });
      }
    }
  });
  return out;
}

/** Text blocks to check, with their positions; blocks inside code-like insets are left out. */
export function checkableBlocks(doc: PMNode): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  const walk = (node: PMNode, pos: number) => {
    node.forEach((child, offset) => {
      const p = pos + offset;
      if (child.type.name === 'inset' && NO_SPELL_INSETS.has(`${child.attrs.name}${child.attrs.arg ? ' ' + child.attrs.arg : ''}`) || (child.type.name === 'inset' && NO_SPELL_INSETS.has(String(child.attrs.name)))) return;
      if (child.isTextblock) { out.push({ node: child, pos: p }); walk(child, p + 1); }
      else if (!child.isLeaf && !child.isInline) walk(child, p + 1);
      else if (child.type.name === 'inset' || child.type.name === 'table') walk(child, p + 1);
    });
  };
  walk(doc, 0);
  return out;
}
