/** Round-trip every formula of the user's documents through parseFormula/writeFormula and report mismatches. */
import { readFileSync } from 'node:fs';
import { parseFormula, writeFormula, type MacroTable } from '../packages/core/src/math';

const dir = process.argv[2] ?? '/tmp/claude-0/-root-lyx/9250d901-48e6-4b48-98b5-a211e39f6f1d/scratchpad/corpus';
const formulas: { file: string; latex: string }[] = JSON.parse(readFileSync(dir + '/formulas.json', 'utf8'));
const macroInsets: { file: string; lines: string[] }[] = JSON.parse(readFileSync(dir + '/macros.json', 'utf8'));
// macro tables per project (top-level directory under /root/projects): FormulaMacro insets + macros.tex
const project = (f: string) => f.split('/').slice(0, 4).join('/');
const tables = new Map<string, MacroTable>();
const tableFor = (f: string): MacroTable => { const p = project(f); let t = tables.get(p); if (!t) { t = {}; tables.set(p, t); } return t; };
for (const m of macroInsets) {
  const r = /^\\(?:re)?newcommand(?:x)?\{\\([A-Za-z]+)\}(?:\[(\d+)\])?(?:\[[^\]]*\])?/.exec(m.lines[0]);
  if (r) tableFor(m.file)[r[1]] = { nargs: Number(r[2] ?? 0) };
}
for (const p of new Set(formulas.map(f => project(f.file)))) {
  try {
    for (const line of readFileSync(p + '/macros.tex', 'utf8').split('\n')) {
      const r = /\\(?:re)?newcommand\*?\{?\\([A-Za-z]+)\}?(?:\[(\d+)\])?/.exec(line);
      if (r && !tableFor(p + '/x')[r[1]]) tableFor(p + '/x')[r[1]] = { nargs: Number(r[2] ?? 0) };
    }
  } catch { /* none */ }
}
const macros: MacroTable = {};   // (unused: per-project tables below)
// only files written by the targeted LyX version (format 643 = LyX 2.5) unless FMT=all
const wanted = process.env.FMT ?? '643';
const fmtOf = new Map<string, string>();
for (const f of new Set(formulas.map(x => x.file))) { const m = /\\lyxformat (\d+)/.exec(readFileSync(f, 'utf8').slice(0, 400)); fmtOf.set(f, m?.[1] ?? '?'); }
const selected = wanted === 'all' ? formulas : formulas.filter(f => fmtOf.get(f.file) === wanted);
console.log(`${selected.length} formulas from files with lyxformat ${wanted}`);
let ok = 0;
const bad: { latex: string; out: string; at: number }[] = [];
const t0 = Date.now();
for (const f of selected) {
  let out: string;
  try { out = writeFormula(parseFormula(f.latex, tableFor(f.file))); } catch (e) { out = 'EXCEPTION ' + (e as Error).message; }
  if (out === f.latex) ok++;
  else { let i = 0; while (i < out.length && out[i] === f.latex[i]) i++; bad.push({ latex: f.latex, out, at: i }); }
}
console.log(`${ok}/${selected.length} identical (${(100 * ok / selected.length).toFixed(2)}%) in ${Date.now() - t0} ms, ${[...tables.values()].reduce((n, t) => n + Object.keys(t).length, 0)} macros in ${tables.size} projects`);
// group mismatches by the text around the first difference
const groups = new Map<string, number>();
for (const b of bad) { const k = b.latex.slice(Math.max(0, b.at - 6), b.at + 10).replace(/\n/g, '⏎'); groups.set(k, (groups.get(k) ?? 0) + 1); }
const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
for (const [k, n] of top) console.log(String(n).padStart(5), JSON.stringify(k));
const show = Number(process.env.SHOW ?? 6);
for (const b of bad.slice(0, show)) {
  console.log('--- expected:', JSON.stringify(b.latex.slice(Math.max(0, b.at - 40), b.at + 60)));
  console.log('    got     :', JSON.stringify(b.out.slice(Math.max(0, b.at - 40), b.at + 60)));
}
