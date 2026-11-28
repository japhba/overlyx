/**
 * The .tex reader and writer on input no author writes on purpose: they must neither throw nor
 * take time quadratic in the size of one construct (they run on the server's only thread), and
 * what they cannot follow stays in the document as raw LaTeX.
 *   npx vitest run tests/tex-robust.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { plainText, walkInsets } from '../packages/core/src/lyx/ast.ts';
import { LYX_LAYOUTS } from './lyxlib.ts';

const opts = { layoutDir: LYX_LAYOUTS };
const wrap = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const body = (text: string) => text.slice(text.indexOf('\\begin{document}') + 16, text.lastIndexOf('\\end{document}'));
/** milliseconds a call takes */
const timed = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };

describe('time is linear in the size of one construct', () => {
  // (each of these took a minute or more before; the bounds leave a loaded machine a wide margin)
  it('a paragraph of 80,000 words on one line', () => {
    let out = '';
    const ms = timed(() => { out = writeTex(parseTex(wrap('word '.repeat(80_000)), opts).doc, opts).text; });
    expect(body(out).trim()).toBe('word '.repeat(80_000).trim());
    expect(ms).toBeLessThan(15_000);
  });

  it('a run of 100,000 commands OverLyX does not know', () => {
    const src = '\\a'.repeat(100_000);
    let out = '';
    const ms = timed(() => { out = writeTex(parseTex(wrap(src), opts).doc, opts).text; });
    expect(body(out).trim()).toBe(src);
    expect(ms).toBeLessThan(15_000);
  });

  it('a table of 20,000 rows', () => {
    const src = '\\begin{tabular}{ll}\n' + 'a & b\\\\\n'.repeat(20_000) + '\\end{tabular}';
    let out = '';
    const ms = timed(() => { out = writeTex(parseTex(wrap(src), opts).doc, opts).text; });
    expect(out.split('a & b').length - 1).toBe(20_000);
    expect(ms).toBeLessThan(20_000);
  });
});

describe('nesting deeper than the reader follows is kept as raw LaTeX', () => {
  const cases: [string, string][] = [
    ['groups', '{'.repeat(5000) + 'x' + '}'.repeat(5000)],
    ['groups never closed', 'a {x '.repeat(20_000)],
    ['font commands', '\\emph{'.repeat(3000) + 'x' + '}'.repeat(3000)],
    ['footnotes', 'a\\footnote{'.repeat(2000) + 'x' + '}'.repeat(2000)],
    ['lists', '\\begin{itemize}\\item '.repeat(1500) + 'x' + '\\end{itemize}'.repeat(1500)],
    ['unknown environments', '\\begin{foo}'.repeat(3000) + 'x' + '\\end{foo}'.repeat(3000)],
    ['floats and boxes never closed', '\\begin{figure}\\begin{minipage}{1cm}\\begin{center}'.repeat(1500) + 'x'],
  ];
  it.each(cases)('%s', (_name, src) => {
    const parsed = parseTex(wrap(src), opts);
    // the innermost text is still in the document …
    const all = plainText(parsed.doc.body) + [...walkInsets(parsed.doc.body)].map(x => (x.inset.type === 'Text' ? plainText(x.inset.paragraphs) : '')).join(' ');
    expect(all).toContain('x');
    // … and the document can be written and read again
    const out = writeTex(parsed.doc, opts).text;
    expect(out).toContain('x');
    expect(() => parseTex(out, opts)).not.toThrow();
  });

  it('keeps a group beyond the limit byte for byte', () => {
    const deep = '{'.repeat(300) + '\\textbf{x} $y$ % c\n z' + '}'.repeat(300);
    const out = writeTex(parseTex(wrap('A ' + deep + ' B'), opts).doc, opts).text;
    expect(out).toContain('{'.repeat(100) + '\\textbf{x} $y$ % c\n z' + '}'.repeat(100));
  });
});
