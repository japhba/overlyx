/**
 * A heading typed right after a table that ends the document (Ctrl+End, Section, "Conclusion"):
 * the heading style made one paragraph of the table and the heading, written as
 * \section{\begin{tabular}…\end{tabular}Conclusion} (the build failed), and selecting the heading's
 * line selected the table, which a Delete then removed. The editor now starts the heading as a
 * paragraph of its own (editor/commands.ts setLayout), and the writer never puts a table, a float
 * or a display formula into a heading's argument (tex/write.ts liftBlocks).
 *   npx vitest run tests/heading-after-table.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
// the client's math node views touch `window` at import time
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') { g.window = g; if (g.navigator && g.navigator.appVersion === undefined) Object.defineProperty(g.navigator, 'appVersion', { value: '', configurable: true }); } });
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { lyxToPm, pmToLyxBody } from '../packages/core/src/index.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { setLayout } from '../packages/client/src/editor/commands.ts';

const TABLE_LAST = '\\documentclass{article}\n\\begin{document}\nSome text.\n\n\\begin{tabular}{|c|c|c|}\n\\hline\na & b & c\\\\\n\\hline\n\\end{tabular}\n\\end{document}\n';

const hasPdflatex = (() => { try { execFileSync('pdflatex', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe('a heading typed after a table that ends the document', () => {
  it('the writer puts the table before the heading, not into its argument', () => {
    const p = parseTex(TABLE_LAST);
    const last = p.doc.body[p.doc.body.length - 1];
    last.layout = 'Section';
    last.items.push({ kind: 'text', text: 'Conclusion', font: {} });
    const out = writeTex(p.doc).text;
    expect(out).toContain('\\end{tabular}\n\n\\section{Conclusion}');
    expect(out).not.toMatch(/\\section\{[^}]*\\begin\{tabular\}/);
    const back = parseTex(out).doc.body;
    expect(back.map(x => x.layout)).toEqual(['Standard', 'Standard', 'Section']);
    expect(back[1].items.some(it => it.kind === 'inset' && it.inset.type === 'Tabular')).toBe(true);
    if (hasPdflatex) {
      const dir = mkdtempSync(join(tmpdir(), 'overlyx-heading-'));
      try {
        writeFileSync(join(dir, 'main.tex'), out);
        execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: dir, stdio: 'ignore', timeout: 60000 });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('Section with the cursor after the table starts a paragraph of its own; the table stays', () => {
    const doc = schema.nodeFromJSON(lyxToPm(parseTex(TABLE_LAST).doc));
    let state = EditorState.create({ schema, doc });
    // Ctrl+End: the end of the last paragraph, right after the table
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)));
    let next = state;
    expect(setLayout('Section')(state, tr => { next = state.apply(tr); })).toBe(true);
    next = next.apply(next.tr.insertText('Conclusion'));
    const body = pmToLyxBody(next.doc);
    expect(body.map(p => p.layout)).toEqual(['Standard', 'Standard', 'Section']);
    expect(body[1].items.some(it => it.kind === 'inset' && it.inset.type === 'Tabular')).toBe(true);
    expect(body[2].items).toEqual([expect.objectContaining({ kind: 'text', text: 'Conclusion' })]);
    // selecting the heading's line and deleting it leaves the table alone
    const $h = next.doc.resolve(next.doc.content.size - 1);
    next = next.apply(next.tr.setSelection(TextSelection.create(next.doc, $h.start(), $h.end())).deleteSelection());
    const after = pmToLyxBody(next.doc);
    expect(after[1].items.some(it => it.kind === 'inset' && it.inset.type === 'Tabular')).toBe(true);
  });

  it('a heading style on a paragraph without a table is unchanged', () => {
    const doc = schema.nodeFromJSON(lyxToPm(parseTex('\\documentclass{article}\n\\begin{document}\nIntroduction\n\\end{document}\n').doc));
    let state = EditorState.create({ schema, doc });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    let next = state;
    setLayout('Section')(state, tr => { next = state.apply(tr); });
    expect(pmToLyxBody(next.doc).map(p => p.layout)).toEqual(['Section']);
  });
});
