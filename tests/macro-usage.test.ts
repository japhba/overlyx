/**
 * LaTeX the editor can only show as TeX code, counted anonymously (usage kind `macro`): the one detail
 * form (core usagePayload.ts) on every path — client, VS Code's sanitizer, the server's store and its
 * report (named only once met in MACRO_MIN_SESSIONS sessions) — what formulas and TeX-code boxes
 * report (core math/mathjax.ts onUnknownMathCommand, client plugins/macrousage.ts), and the
 * maintenance worker's signal.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-macro-usage-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { db } = await import('../packages/server/src/db.ts');
const { config } = await import('../packages/server/src/config.ts');
const usage = await import('../packages/server/src/usage.ts');
const { summarise, formatUsageReport, MACRO_MIN_SESSIONS } = await import('../packages/server/src/usageReport.ts');
const { macroUsageDetail, parseMacroUsageDetail, sanitizeUsageEvents } = await import('../packages/core/src/usagePayload.ts');
const { parseFormula, renderHullSource, onUnknownMathCommand } = await import('../packages/core/src/index.ts');
const { ertCommand } = await import('../packages/client/src/editor/plugins/macrousage.ts');
const { databaseSignals } = await import('../scripts/maintenance.ts');
if (!config.dataDir.startsWith(ROOT)) throw new Error('the test would use the real data directory: ' + config.dataDir);
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('the detail', () => {
  it('is a kind and a bare command name, letters only', () => {
    expect(macroUsageDetail('math', 'qty')).toBe('math qty');
    expect(macroUsageDetail('env', 'tikzpicture')).toBe('env tikzpicture');
    expect(macroUsageDetail('text', 'section*')).toBe('text section*');
    for (const bad of ['x', 'my_macro', 'foo2', 'a'.repeat(33), 'foo{bar}', '\\foo']) expect(macroUsageDetail('math', bad)).toBeNull();
    expect(parseMacroUsageDetail('math foo bar')).toBeNull();
    expect(parseMacroUsageDetail('other foo')).toBeNull();
  });

  it('passes VS Code\'s sanitizer as it is, anything else is dropped', () => {
    const out = sanitizeUsageEvents([
      { name: 'macro', detail: 'math qty', where: 'math', ok: true, dt: 5 },
      { name: 'macro', detail: 'math \\qty{3}{m}' },
      { name: 'macro', detail: 'text Jane Doe' },
    ]);
    expect(out).toEqual([{ name: 'macro', detail: 'math qty', where: 'math', ago: 0 }]);
  });

  it('is stored only in that form, and kept 30 days like the detailed interactions', () => {
    db.exec('DELETE FROM usage_events');
    const now = 1_800_000_000_000;
    expect(usage.storeUsage('abcdef0123456789', [
      { name: 'macro', detail: 'math qty', where: 'math' },
      { name: 'macro', detail: 'text see thesis/main.tex' },
    ], now)).toBe(1);
    expect(db.prepare("SELECT detail FROM usage_events WHERE name = 'macro'").all()).toEqual([{ detail: 'math qty' }]);
    usage.pruneUsage(now + 31 * 86400000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE name = 'macro'").get()).toEqual({ n: 0 });
  });
});

describe('the report and the maintenance worker', () => {
  const row = (session: string, detail: string) => ({ session, at: 1, name: 'macro', detail, ok: null, place: 'math', dt: null });
  const sessions = Array.from({ length: MACRO_MIN_SESSIONS }, (_, i) => `s${i}`.padEnd(16, '0'));
  const rows = [...sessions.map(s => row(s, 'math qty')), ...sessions.map(s => row(s, 'env tikzpicture')), row('lonely0000000000', 'math janesmacro')];

  it('names a command once several sessions met it; rarer ones are only counted', () => {
    const s = summarise(rows, { since: 0, until: 10, top: 40 });
    expect(s.macros.listed.map(m => m.key)).toEqual(['env tikzpicture', 'math \\qty']);
    expect(s.macros.rare).toBe(1);
    const text = formatUsageReport(s);
    expect(text).toContain('Macros shown as TeX code');
    expect(text).toContain('math \\qty');
    expect(text).not.toContain('janesmacro');
  });

  it('becomes a low-priority signal that asks the worker to judge and draw it', () => {
    db.exec('DELETE FROM usage_events');
    const now = Date.now();
    for (const s of sessions) usage.storeUsage(s.replace(/[^a-f0-9]/g, 'a'), [{ name: 'macro', detail: 'math qty', where: 'math' }], now);
    const signals = databaseSignals(db, now - 86400000).filter(x => x.kind === 'unrendered-macro');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ key: 'unrendered-macro:math \\qty', priority: 7 });
    expect(signals[0].title).toContain('\\qty');
    expect(signals[0].detail).toContain('no_fix');
  });
});

describe('what is reported', () => {
  it('formulas: unknown commands and environments, not known ones or the document\'s own macros', () => {
    const seen: string[] = [];
    onUnknownMathCommand((kind, name) => seen.push(`${kind} ${name}`));
    try {
      const macros = { mine: { def: 'x', args: 0 } } as never;
      for (const f of ['\\alpha + \\qty{3}{m}', '\\begin{weirdenv} a \\end{weirdenv}', '\\mine + \\frac{a}{b}']) renderHullSource(parseFormula(f, macros), macros);
    } finally { onUnknownMathCommand(null); }
    expect(seen).toContain('math qty');
    expect(seen).toContain('env weirdenv');
    expect(seen.some(s => /alpha|frac|mine/.test(s))).toBe(false);
  });

  it('TeX-code boxes: their first command, or the environment they begin', () => {
    expect(ertCommand('\\vspace{2mm}\\noindent')).toEqual({ kind: 'text', name: 'vspace' });
    expect(ertCommand('% a comment \\foo\n\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}')).toEqual({ kind: 'env', name: 'tikzpicture' });
    expect(ertCommand('plain words')).toBeNull();
  });
});
