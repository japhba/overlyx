// Which LyX predefined macros (lib/symbols \def entries) does KaTeX not know? Those get their LyX
// definition as a KaTeX macro; the rest render natively. Writes packages/core/src/math/katex-macros.json.
import { readFileSync, writeFileSync } from 'node:fs';
import katex from 'katex';
const symbols = JSON.parse(readFileSync(new URL('../packages/core/src/math/symbols.json', import.meta.url), 'utf8'));
const out = {};
const nativeNames = [];
let native = 0, unknownDef = 0;
let warned = false;
const origWarn = console.warn; console.warn = () => { warned = true; };
const tryRender = (src) => { warned = false; katex.renderToString(src, { throwOnError: true, strict: false, trust: true }); if (warned) throw new Error('metrics'); };
for (const [name, e] of Object.entries(symbols)) {
  if (!/^[A-Za-z]+\*?$/.test(name)) continue;
  let ok = true;
  try { tryRender('\\' + name); } catch { ok = false; }
  if (ok) { native++; nativeNames.push(name); continue; }
  if (e.i === 'macro' && e.d) {
    // usable only if KaTeX can render the definition
    try { tryRender(e.d); out[name] = e.d; } catch { unknownDef++; }
  } else if (e.i === 'sym' && e.u) {
    const d = e.c === 'mathrel' ? `\\mathrel{\\text{${e.u}}}` : e.c === 'mathbin' ? `\\mathbin{\\text{${e.u}}}` : e.c === 'mathop' ? `\\mathop{\\text{${e.u}}}` : `\\text{${e.u}}`;
    try { tryRender(d); out[name] = d; } catch { unknownDef++; }
  }
}
writeFileSync(new URL('../packages/core/src/math/katex-macros.json', import.meta.url), JSON.stringify({ macros: out, native: nativeNames }));
console.log(`${native} native, ${Object.keys(out).length} defined for KaTeX, ${unknownDef} definitions KaTeX cannot render`);
