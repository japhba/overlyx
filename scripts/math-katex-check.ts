/** Render every corpus formula through the new KaTeX source generator and report what KaTeX rejects. */
import { readFileSync } from 'node:fs';
import katex from 'katex';
import { parseFormula, renderHullSource, katexMacros, type MacroTable } from '../packages/core/src/math';
import { macroFromLyxLines, macrosFromLatex } from '../packages/core/src/macros';

const dir = '/tmp/claude-0/-root-lyx/9250d901-48e6-4b48-98b5-a211e39f6f1d/scratchpad/corpus';
const formulas: { file: string; latex: string }[] = JSON.parse(readFileSync(dir + '/formulas.json', 'utf8'));
const macroInsets: { file: string; lines: string[] }[] = JSON.parse(readFileSync(dir + '/macros.json', 'utf8'));
const project = (f: string) => f.split('/').slice(0, 4).join('/');
const tables = new Map<string, MacroTable>();
const tableFor = (f: string): MacroTable => { const p = project(f); let t = tables.get(p); if (!t) { t = {}; tables.set(p, t); } return t; };
for (const p of new Set(formulas.map(f => project(f.file)))) {
  try { for (const m of macrosFromLatex(readFileSync(p + '/macros.tex', 'utf8')).macros) tableFor(p + '/x')[m.name] = { nargs: m.args, def: m.display ?? m.def }; } catch { /* none */ }
}
for (const m of macroInsets) { const d = macroFromLyxLines(m.lines); if (d) tableFor(m.file)[d.name] = { nargs: d.args, def: d.display ?? d.def }; }
const fmt = new Map<string, string>();
for (const f of new Set(formulas.map(x => x.file))) { const m = /\\lyxformat (\d+)/.exec(readFileSync(f, 'utf8').slice(0, 400)); fmt.set(f, m?.[1] ?? '?'); }
const sel = formulas.filter(f => fmt.get(f.file) === '643');
let ok = 0; const errs = new Map<string, number>(); const samples = new Map<string, string>();
const t0 = Date.now();
for (const f of sel) {
  const table = tableFor(f.file);
  try {
    const h = parseFormula(f.latex, table);
    const { latex } = renderHullSource(h, table);
    katex.renderToString(latex, { throwOnError: true, strict: false, trust: true, displayMode: h.type !== 'simple', macros: katexMacros(table) });
    ok++;
  } catch (e) {
    const msg = String((e as Error).message).replace(/at position \d+.*/s, '').slice(0, 80);
    errs.set(msg, (errs.get(msg) ?? 0) + 1);
    if (!samples.has(msg)) samples.set(msg, f.latex.slice(0, 120));
  }
}
console.log(`${ok}/${sel.length} rendered by KaTeX in ${Date.now() - t0} ms`);
for (const [k, n] of [...errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(String(n).padStart(5), k, '   e.g.', JSON.stringify(samples.get(k)));
