import { describe, expect, it } from 'vitest';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { markEditedSettings } from '../packages/core/src/tex/preamble.ts';
import { walkInsets, plainText, type TextInset } from '../packages/core/src/lyx/ast.ts';
import { exportLatex } from '../packages/core/src/latex/index.ts';

const source = (body: string, pre = '') => `\\documentclass{article}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`;
const branch = (name: string, inverted: boolean, text: string): TextInset => ({ type: 'Text', name: 'Branch', arg: name, status: 'collapsed', params: ['inverted ' + Number(inverted)], paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text, font: {} }] }] });
const branches = (text: string) => [...walkInsets(parseTex(text).doc.body)].map(x => x.inset).filter((i): i is TextInset => i.type === 'Text' && i.name === 'Branch');

describe('editable native source fidelity', () => {
  it.each([false, true])('preserves branch activation, contents, inversion and nesting (selected %s)', selected => {
    const doc = parseTex(source('Before.\n\nAfter.')).doc;
    doc.header.lines.push('\\branch Draft', '\\selected ' + Number(selected), '\\end_branch');
    const inset = branch('Draft', false, 'ALTERNATIVE');
    inset.paragraphs[0].items.push({ kind: 'inset', font: {}, inset: branch('Draft', true, 'INVERTED') });
    doc.body[0].items.push({ kind: 'inset', font: {}, inset });
    const first = writeTex(doc).text;
    const restored = branches(first);
    expect(restored).toHaveLength(2);
    expect(restored[0].arg).toBe('Draft');
    expect(restored[0].status).toBe('collapsed');
    expect(restored[1].params).toContain('inverted 1');
    expect(plainText(restored[0].paragraphs)).toContain('ALTERNATIVE');
    expect(writeTex(parseTex(first).doc).text).toBe(first);
    const body = exportLatex(parseTex(first).doc).tex.split('\\begin{document}')[1];
    expect(body.includes('ALTERNATIVE')).toBe(selected);
    expect(body.includes('INVERTED')).toBe(false);
  });
  it('preserves commands before documentclass on the first and second rewrite', () => {
    const prefix = '\\PassOptionsToPackage{dvipsnames}{xcolor}\n\\RequirePackage{fix-cm}\n';
    const first = writeTex(parseTex(prefix + source('Text.')).doc).text;
    expect(first.startsWith(prefix)).toBe(true);
    expect(writeTex(parseTex(first).doc).text).toBe(first);
  });
  it('keeps cleveref lists, ranges and capitalization editable', () => {
    const first = writeTex(parseTex(source('See \\cref{sec:a,sec:b} and \\Crefrange{sec:a}{sec:c}.')).doc).text;
    expect(first).toContain('\\cref{sec:a,sec:b}');
    expect(first).toContain('\\Crefrange{sec:a}{sec:c}');
    expect(first).toContain('\\usepackage{cleveref}');
    expect(writeTex(parseTex(first).doc).text).toBe(first);
  });
});

it('settings control output and an explicit reset overrides manual preamble values', () => {
  const doc = parseTex(source('\\section{First}\n\\subsection{Second}', '\\usepackage{setspace}\n\\doublespacing\n\\setcounter{secnumdepth}{4}')).doc;
  const edit = (values: Record<string, string>) => {
    const before = [...doc.header.lines];
    for (const [k, v] of Object.entries(values)) {
      const i = doc.header.lines.findIndex(l => l.startsWith('\\' + k + ' '));
      if (i >= 0) doc.header.lines[i] = '\\' + k + ' ' + v; else doc.header.lines.push('\\' + k + ' ' + v);
    }
    doc.header.lines = markEditedSettings(before, doc.header.lines, Object.keys(values));
  };
  edit({ spacing: 'double', secnumdepth: '1', use_lineno: 'true', use_geometry: 'true', leftmargin: '2cm', pdf_title: '"Review test"', pdf_bookmarks: 'false', pdf_backref: 'true', paperfontsize: '12' });
  const text = writeTex(doc).text;
  expect(text).toContain('\\AtBeginDocument{\\doublespacing}');
  expect(text).toContain('\\AtBeginDocument{\\setcounter{secnumdepth}{1}}');
  expect(text).toContain('\\AtBeginDocument{\\linenumbers}');
  expect(text).toContain('\\geometry{left=2cm}');
  expect(text).toContain('pdftitle={Review test}');
  expect(text).toContain('\\PassOptionsToPackage{bookmarks=false,backref=true}{hyperref}');
  expect(text).toContain('\\documentclass[12pt]{article}');
  expect(writeTex(parseTex(text).doc).text).toBe(text);
  edit({ spacing: 'single', secnumdepth: '3', use_lineno: 'false' });
  const reset = writeTex(doc).text;
  expect(reset).toContain('\\AtBeginDocument{\\singlespacing}');
  expect(reset).toContain('\\AtBeginDocument{\\setcounter{secnumdepth}{3}}');
  expect(reset).toContain('\\AtBeginDocument{\\nolinenumbers}');
  expect(writeTex(parseTex(reset).doc).text).toBe(reset);
});
