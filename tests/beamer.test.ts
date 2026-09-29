import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';

import { parseTex, writeTex, importLyx } from '../packages/core/src/tex/index.ts';
const files = ['/root/lyx/lib/examples/Presentations', '/root/lyx/lib/examples/Posters', '/root/lyx/lib/examples/de/Presentations', '/root/lyx/lib/examples/fr/Presentations', '/root/lyx/lib/examples/es/Presentations'].filter(existsSync).flatMap(d => readdirSync(d).filter(f => f.endsWith('.lyx') && /beamer/i.test(f)).map(f => join(d, f)));
describe('beamer corpus', () => {
  for (const f of files) it(f, () => {
    const dir = dirname(f);
    const text = readFileSync(f, 'utf8');
    const readFile = (n: string) => { const p = join(dir, n); return existsSync(p) ? readFileSync(p, 'utf8') : undefined; };
    const imp = importLyx(text, { localDirs: [dir], readFile, sourceName: basename(f) });
    const opts = { localDirs: [dir], readFile };
    const p1 = parseTex(imp.tex, opts);
    const w1 = writeTex(p1.doc, opts).text;
    const p2 = parseTex(w1, opts);
    const w2 = writeTex(p2.doc, opts).text;
    const p3 = parseTex(w2, opts);
    const w3 = writeTex(p3.doc, opts).text;
    const blanks = (t: string) => t.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l !== '').join('\n');
    expect(blanks(w2)).toBe(blanks(w1));
    expect(w3).toBe(w2);
    // the LyX original's frames: the import keeps them
    const frames = (t: string) => (t.match(/\\begin\{frame\}/g) ?? []).length;
    expect(frames(w1)).toBe(frames(imp.tex));
  });
});

describe('hand-written beamer decks', () => {
  const deck = [
    '\\documentclass[aspectratio=169]{beamer}',
    '\\title{Overlay test}',
    '\\begin{document}',
    '\\begin{frame}',
    '\\titlepage',
    '\\end{frame}',
    '',
    '\\begin{frame}[fragile]{Pauses and items}{A subtitle}',
    '\\begin{itemize}',
    '\\item<1-> First point',
    '\\item<2->[b)] Second point with $x^2$',
    '\\end{itemize}',
    'Some text \\pause more text after the pause.',
    '\\end{frame}',
    '\\begin{frame}',
    '\\frametitle{Only and uncover}',
    '\\only<1>{Only on slide one.}\\only<2>{Only on slide two.} \\uncover<2->{Uncovered from two.} \\alert<2>{Alert on two.}',
    '\\begin{itemize}[<+->]',
    '\\item a',
    '\\item b',
    '\\end{itemize}',
    '',
    '\\pause',
    '',
    '\\begin{columns}',
    '\\column{0.5\\textwidth}',
    'Left \\visible<2>{shown on 2} \\textbf<3>{bold on 3}',
    '\\end{columns}',
    '\\end{frame}',
    '\\end{document}',
    '',
  ].join('\n');
  const w1 = writeTex(parseTex(deck).doc).text;
  it('keeps every frame, its title, options and overlay specifications', () => {
    expect((w1.match(/\\begin\{frame\}/g) ?? []).length).toBe(3);
    expect(w1).toContain('\\begin{frame}[fragile]{Pauses and items}');
    expect(w1).toContain('\\framesubtitle{A subtitle}');
    expect(w1).toContain('\\item<1-> First point');
    expect(w1).toContain('\\item[b)]<2-> Second point');   // LyX's order (beamer takes both)
    expect(w1).toContain('Some text \\pause more text after the pause.');
    expect(w1).toContain('\\frametitle{Only and uncover}');
    expect(w1).toContain('\\only<1>{Only on slide one.}\\only<2>{Only on slide two.} \\uncover<2->{Uncovered from two.} \\alert<2>{Alert on two.}');
    expect(w1).toContain('\\begin{itemize}[<+->]');
    expect(w1).toContain('\\pause{}');
    expect(w1).toContain('\\visible<2>{shown on 2} \\textbf<3>{bold on 3}');
    // \frametitle, \pause and \column stay inside their frame
    const third = w1.slice(w1.lastIndexOf('\\begin{frame}'), w1.lastIndexOf('\\end{frame}'));
    for (const cmd of ['\\frametitle', '\\pause{}', '\\column{0.5\\textwidth}', '\\begin{columns}']) expect(third).toContain(cmd);
  });
  it('is stable from the first save on', () => {
    const w2 = writeTex(parseTex(w1).doc).text;
    expect(w2).toBe(w1);
  });
  it('the overlay specification is an argument inset, the frame title too', () => {
    const d = parseTex(deck).doc;
    const frames = d.body.filter(p => p.layout === 'Frame');
    const args = (p: typeof frames[number]) => p.items.flatMap(it => it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Argument' ? [it.inset.arg] : []);
    expect(frames.some(p => args(p).includes('4') && args(p).includes('3'))).toBe(true);
    const items = d.body.filter(p => p.layout === 'Itemize');
    expect(args(items[0])).toEqual(['item:2']);
    expect(d.body.some(p => p.layout === 'FrameTitle' && p.depth === 1)).toBe(true);
    expect(d.body.some(p => p.layout === 'Pause' && p.depth === 1)).toBe(true);
  });
  it('two lists in a row stay two lists (any document class)', () => {
    const t = '\\documentclass{article}\n\\begin{document}\n\\begin{itemize}\n\\item a\n\\end{itemize}\n\n\\begin{itemize}\n\\item b\n\\end{itemize}\n\\end{document}\n';
    const w = writeTex(parseTex(t).doc).text;
    expect((w.match(/\\begin\{itemize\}/g) ?? []).length).toBe(2);
    expect(writeTex(parseTex(w).doc).text).toBe(w);
  });
});

describe('beamer column environments and \\parbox', () => {
  it('\\begin{column}{w} … \\end{column} is LyX\'s Column paragraph; environments inside stay inside', () => {
    const t = '\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{T}\n\\begin{columns}[t]\n\\begin{column}{0.5\\textwidth}\n\\begin{center}\nLeft\n\\end{center}\n\\end{column}\n\\begin{column}[T]{0.4\\textwidth}\nRight\n\\end{column}\n\\end{columns}\n\\end{frame}\n\\end{document}\n';
    const d = parseTex(t).doc;
    expect(d.body.filter(p => p.layout === 'Column').map(p => p.depth)).toEqual([2, 2]);
    const w1 = writeTex(d).text;
    expect(w1).toContain('\\column{0.5\\textwidth}');
    expect(w1).toContain('\\column[T]{0.4\\textwidth}');
    const body = w1.slice(w1.indexOf('\\begin{columns}'), w1.indexOf('\\end{columns}'));
    expect(body).toContain('Left');
    expect(body).toContain('Right');
    expect((w1.match(/\\begin\{center\}/g) ?? []).length).toBe((w1.match(/\\end\{center\}/g) ?? []).length);
    expect(writeTex(parseTex(w1).doc).text).toBe(w1);
  });
  it('\\parbox with a paragraph break inside is a frameless box (the paragraph around it stays whole)', () => {
    const t = '\\documentclass{article}\n\\begin{document}\nBefore \\parbox[c]{0.5\\linewidth}{One\\par\\medskip\nTwo} after.\n\\end{document}\n';
    const d = parseTex(t).doc;
    const box = d.body[0].items.find(it => it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Box');
    expect(box).toBeTruthy();
    const w1 = writeTex(d).text;
    expect(w1).toMatch(/\\parbox\[c\]\{0\.5\\linewidth\}\{%\nOne\n\n\\medskip\{\}\nTwo%\n\}/);
    expect(writeTex(parseTex(w1).doc).text).toBe(w1);
  });
});
