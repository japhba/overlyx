import { describe, it, expect } from 'vitest';
import { setDocumentMacros, macroTableFor } from '../packages/client/src/editor/lyxmath/macrotable';

const A = {}, B = {}, C = {};

describe('per-view macro tables (open documents must not clobber each other)', () => {
  it('each view keeps its own server macros', () => {
    setDocumentMacros(A, { bh: { def: '\\boldsymbol{h}', args: 0 } });
    setDocumentMacros(B, {});
    expect(macroTableFor(A, undefined).table.bh).toEqual({ nargs: 0, def: '\\boldsymbol{h}' });
    expect(macroTableFor(B, undefined).table.bh).toBeUndefined();
    // applying B's (empty) table did not touch A's — the old single global did exactly that
    expect(macroTableFor(A, undefined).table.bh).toBeTruthy();
  });
  it('merge stacks onto the table applied just before (master, then children)', () => {
    setDocumentMacros(A, { a: { def: 'x', args: 0 } });
    setDocumentMacros(C, { b: { def: 'y', args: 0 } }, true);
    expect(macroTableFor(C, undefined).table.a).toBeTruthy();
    expect(macroTableFor(C, undefined).table.b).toBeTruthy();
    expect(macroTableFor(A, undefined).table.b).toBeUndefined();
  });
  it('fallback macros are present and cache keys differ per view', () => {
    expect(macroTableFor(A, undefined).table.abs).toBeTruthy();
    // siunitx: \SI{30}{\milli\second} draws (usage report: shown as TeX code in 4 sessions)
    expect(macroTableFor(A, undefined).table.SI).toEqual({ nargs: 2, def: '#1\\,\\mathrm{#2}' });
    expect(macroTableFor(A, undefined).table.milli.def).toBe('m');
    expect(macroTableFor(A, undefined).key).not.toBe(macroTableFor(B, undefined).key);
  });
});

describe('the Agent panel draws with the project\'s macros (agentText.tsx)', async () => {
  const { refreshMacros, projectMacroTable } = await import('../packages/client/src/editor/macrodefs');
  const { editorContext } = await import('../packages/client/src/editor/context');
  const { parseFormula, renderHullSource, onUnknownMathCommand, withoutUnknownCounting } = await import('../packages/core/src/index.ts');
  const fakeView = (project: string) => ({ dom: { dataset: { project } }, state: { doc: { descendants() { /* no FormulaMacro insets */ } } }, isDestroyed: false }) as never;
  // the metadata's form ({ def, args }), as App.tsx hands it over
  const paper = { bh: { def: '\\boldsymbol{h}', args: 0, expand: false }, inv: { def: '{#1}^{-1}', args: 1, expand: false } };

  it('in the parser\'s form, with the arguments', () => {
    const v = fakeView('jan/paper');
    refreshMacros(v, paper);
    editorContext.activeView = v;
    const t = projectMacroTable('jan/paper');
    expect(t.bh).toEqual({ nargs: 0, def: '\\boldsymbol{h}' });
    expect(t.inv.nargs).toBe(1);
  });
  it('keeps the paper\'s beside a markdown note of the project, and no other project\'s', () => {
    const note = fakeView('jan/paper');
    refreshMacros(note, {});   // a markdown note: no macros
    editorContext.activeView = note;
    expect(projectMacroTable('jan/paper').bh).toBeTruthy();
    const other = fakeView('jan/other');
    refreshMacros(other, { kap: { def: '\\kappa', args: 0, expand: false } });
    editorContext.activeView = other;
    expect(projectMacroTable('jan/paper').kap).toBeUndefined();
    expect(projectMacroTable('jan/paper').bh).toBeTruthy();
    editorContext.activeView = null;
    expect(projectMacroTable('jan/paper').bh).toBeTruthy();
    expect(projectMacroTable('jan/unseen')).toEqual({});
  });
  it('its unknown commands are not counted as the document\'s', () => {
    const seen: string[] = [];
    onUnknownMathCommand((_k, n) => { seen.push(n); });
    try {
      withoutUnknownCounting(() => renderHullSource(parseFormula('$\\bh+\\qq$', {}), {}));
      expect(seen).toEqual([]);
      renderHullSource(parseFormula('$\\qq$', {}), {});
      expect(seen).toEqual(['qq']);
      // with the project's table the macro is one, and draws
      seen.length = 0;
      withoutUnknownCounting(() => renderHullSource(parseFormula('$\\inv{\\bh}$', projectMacroTable('jan/paper')), projectMacroTable('jan/paper')));
      expect(seen).toEqual([]);
    } finally { onUnknownMathCommand(null); }
  });
});
