// Which LyX predefined macros (lib/symbols \def entries) and symbols does MathJax not know — with
// OverLyX's TeX packages (packages/client/src/editor/lyxmath/mathjax-tex.ts)? Those get their LyX
// definition as a macro of the input jax; the rest render natively. Writes
// packages/core/src/math/mathjax-macros.json. Run: npx tsx scripts/gen-mathjax-macros.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { STATE } from '@mathjax/src/js/core/MathItem.js';
import { makeTexInput } from '../packages/client/src/editor/lyxmath/mathjax-tex.ts';

const symbols = JSON.parse(readFileSync(new URL('../packages/core/src/math/symbols.json', import.meta.url), 'utf8'));
RegisterHTMLHandler(liteAdaptor());
// no base macros: a name is native only if MathJax (or OverLyX's package) defines it
const tex = makeTexInput({ macros: {}, strict: true });
const doc = mathjax.document('', { InputJax: tex });
const parses = (src: string) => { try { doc.convert(src, { display: false, end: STATE.COMPILED }); return true; } catch { return false; } };

const out: Record<string, string> = {};
const nativeNames: string[] = [];
let unknownDef = 0;
for (const [name, e] of Object.entries(symbols) as [string, { i?: string; d?: string; u?: string; c?: string }][]) {
  if (!/^[A-Za-z]+\*?$/.test(name)) continue;
  if (parses('\\' + name + '{x}{y}')) { nativeNames.push(name); continue; }
  if (e.i === 'macro' && e.d) {
    // usable only if MathJax can render the definition
    if (parses(e.d)) out[name] = e.d; else unknownDef++;
  } else if (e.i === 'sym' && e.u) {
    const d = e.c === 'mathrel' ? `\\mathrel{\\text{${e.u}}}` : e.c === 'mathbin' ? `\\mathbin{\\text{${e.u}}}` : e.c === 'mathop' ? `\\mathop{\\text{${e.u}}}` : `\\text{${e.u}}`;
    if (parses(d)) out[name] = d; else unknownDef++;
  }
}
writeFileSync(new URL('../packages/core/src/math/mathjax-macros.json', import.meta.url), JSON.stringify({ macros: out, native: nativeNames }));
console.log(`${nativeNames.length} native, ${Object.keys(out).length} defined for MathJax, ${unknownDef} definitions MathJax cannot render`);
