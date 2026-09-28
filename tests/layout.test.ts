/**
 * Layout documents (core layout/*): the object keys, lengths, paths and colours; parsing a beamer
 * file of layout pages into the document model and writing it back byte for byte, through the
 * ProseMirror conversion too; the templates of new documents; absolute font sizes; and the build's
 * rewriting of paths that leave the document's folder.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  parseKeys, writeKeys, toMm, fmtNum, parseBoxKeys, writeBoxKeys, parseShapeKeys, writeShapeKeys, parseImageKeys, writeImageKeys,
  normalizePath, pathToString, pathBounds, shapeInBoxUnits, pageSizeOf, evalColor, cssColor, preambleColors, hexToTex, layoutTemplate,
  lyxToPmNode, pmToLyxBody, PAGE_PRESETS, setHeaderValue, LAYOUT_MACROS,
} from '../packages/core/src/index.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { markEditedSettings } from '../packages/core/src/tex/preamble.ts';
import { rewriteParentPaths } from '../packages/server/src/texpaths.ts';

const opts = { layoutDir: path.resolve('lyx/lib/layouts'), localDirs: [] };

const DOC = String.raw`\documentclass[aspectratio=169]{beamer}
\usepackage{lmodern}
\definecolor{jblue}{RGB}{2,61,107}
\begin{document}
\begin{frame}[plain]
\olpage{fill=jblue!5,transition=fade}
\begin{olbox}{x=10mm,y=10mm,w=60mm,h=20mm,fill=[HTML]FFF3BF,draw=jblue,line=1pt,radius=2mm,pad=2mm,valign=c,font=14pt,align=justify}
Hello \textbf{world} with $\int_0^1 x^2\,dx$ inline.
\begin{itemize}
\item a list
\end{itemize}
\end{olbox}
\olshape{x=10mm,y=40mm,w=40mm,h=30mm,vb=0 0 40 30,fill=green!40,draw=black,line=2pt,step=2-,effect=fade}{M 0 0 L 40 0 L 20 30 Z}
% a comment the page keeps
\begin{olgroup}{step=3}
\olimage{x=110mm,y=40mm,w=40mm,h=30mm,crop=0.5 0 0 0.5,name=Plot}{figures/plot.pdf}
\olshape{x=110mm,y=72mm,w=40mm,h=1mm,vb=0 0 40 1,fill=black}{M 0 0 L 40 0 L 40 1 L 0 1 Z}
\end{olgroup}
\begin{olraw}{x=10mm,y=75mm,w=40mm,h=10mm}
\tikz\draw[orange,thick] (0,0) circle (3mm);
\end{olraw}
\note{Say hello.}
\end{frame}

\begin{frame}[plain]
\begin{olbox}{x=1mm,y=1mm,w=6mm,h=2mm}
x
\end{olbox}
\end{frame}
\end{document}
`;

describe('layout keys, lengths and paths', () => {
  it('reads and writes key lists (braces, flags, nested commas)', () => {
    expect(parseKeys('x=10mm, name={A, B}, lock, fill=red!20')).toEqual([['x', '10mm'], ['name', 'A, B'], ['lock', null], ['fill', 'red!20']]);
    expect(writeKeys([['x', '10mm'], ['name', 'A, B'], ['lock', null]])).toBe('x=10mm,name={A, B},lock');
  });
  it('converts TeX lengths to millimetres and formats numbers', () => {
    expect(toMm('1in')).toBeCloseTo(25.4);
    expect(toMm('72.27pt')).toBeCloseTo(25.4);
    expect(toMm('2cm')).toBe(20);
    expect(toMm('3')).toBe(3);
    expect(toMm('3em')).toBeNull();
    expect(fmtNum(1.23456)).toBe('1.23');
    expect(fmtNum(-0.0001)).toBe('0');
  });
  it('writes object keys canonically (parse ∘ write is the identity on OverLyX output)', () => {
    const box = 'x=10mm,y=10mm,w=60mm,h=20mm,fill=[HTML]FFF3BF,draw=jblue,line=1pt,radius=2mm,pad=2mm,valign=c,font=14pt,align=justify,step=2-,name=Title,lock,future=kept';
    expect(writeBoxKeys(parseBoxKeys(box))).toBe(box);
    const shape = 'x=1mm,y=2mm,w=3mm,h=4mm,rotate=30,vb=0 0 3 4,fill=red,draw=blue,line=0.8pt,dash=dashed,arrows=-Stealth';
    expect(writeShapeKeys(parseShapeKeys(shape))).toBe(shape);
    const img = 'x=0mm,y=0mm,w=10mm,h=10mm,crop=0.1 0 0.25 0';
    expect(writeImageKeys(parseImageKeys(img))).toBe(img);
    expect(parseBoxKeys('').align).toBe('left');
  });
  it('normalises SVG path data to absolute M / L / C / Z', () => {
    expect(pathToString(normalizePath('m 10 10 h 5 v 5 l -5 0 z'))).toBe('M 10 10 L 15 10 L 15 15 L 10 15 Z');
    const q = normalizePath('M 0 0 Q 10 10 20 0');
    expect(q[1].c).toBe('C');
    const arc = normalizePath('M 0 50 A 50 50 0 0 1 100 50');
    expect(arc.every(s => s.c === 'M' || s.c === 'C')).toBe(true);
    const b = pathBounds(arc);
    expect(b.y).toBeCloseTo(0, 0);
    expect(b.w).toBeCloseTo(100, 1);
  });
  it('puts a shape path into its box\'s millimetres (equal scales, which TikZ needs)', () => {
    const r = shapeInBoxUnits('M 0 0 L 100 0 L 100 100 L 0 100 Z', '0 0 100 100', 841, 2.5);
    expect(r.vb).toBe('0 0 841 2.5');
    expect(r.d).toBe('M 0 0 L 841 0 L 841 2.5 L 0 2.5 Z');
    expect(shapeInBoxUnits(r.d, r.vb, 841, 2.5)).toEqual(r);
  });
  it('knows the page size from the header: custom paper, beamer aspect ratio, default', () => {
    expect(pageSizeOf(['\\papersize custom', '\\paperwidth 841mm', '\\paperheight 1189mm'])).toEqual({ w: 841, h: 1189 });
    expect(pageSizeOf(['\\options aspectratio=169'])).toEqual({ w: 160, h: 90 });
    expect(pageSizeOf([])).toEqual({ w: 128, h: 96 });
  });
});

describe('xcolor colours', () => {
  it('evaluates names, mixes, explicit models and document colours', () => {
    const doc = preambleColors('\\definecolor{jblue}{RGB}{2,61,107} % Jülich\n\\colorlet{soft}{jblue!25}\n\\definecolor{ink}{HTML}{1C2026}');
    expect(cssColor('jblue', doc)).toBe('#023d6b');
    expect(cssColor('ink', doc)).toBe('#1c2026');
    expect(cssColor('soft', doc)).toBe(cssColor('jblue!25', doc));
    expect(cssColor('red!50')).toBe('#ff8080');
    expect(cssColor('red!50!blue')).toBe('#800080');
    expect(cssColor('-red')).toBe('#00ffff');
    expect(cssColor('[HTML]D62728')).toBe('#d62728');
    expect(cssColor('rgb,255:red,214;green,39;blue,40')).toBe('#d62728');
    expect(cssColor('BurntOrange')).toBe('#ff7d00');
    expect(cssColor('AliceBlue')).toBe('#f0f8ff');
    expect(evalColor('nosuchcolour')).toBeNull();
    expect(hexToTex('#2f5597')).toBe('[HTML]2F5597');
  });
});

describe('layout pages in .tex files', () => {
  it('reads frames of objects as pages of object insets, in drawing order', () => {
    const { doc } = parseTex(DOC, opts);
    const pages = doc.body.filter(p => p.layout === 'OLPage');
    expect(pages).toHaveLength(2);
    const names = pages[0].items.map(it => (it.kind === 'inset' && (it.inset.type === 'Text' || it.inset.type === 'Leaf') ? it.inset.name : '?'));
    expect(names).toEqual(['OLPageProps', 'OLBox', 'OLShape', 'OLRaw', 'OLGroup', 'OLRaw', 'OLNotes']);
  });
  it('writes a file it read back byte for byte, also through ProseMirror', () => {
    const { doc } = parseTex(DOC, opts);
    const w1 = writeTex(doc, opts).text;
    expect(w1.slice(w1.indexOf('\\begin{document}'))).toBe(DOC.slice(DOC.indexOf('\\begin{document}')).replace('\\end{frame}\n\\end{document}', '\\end{frame}\n\n\\end{document}'));
    expect(w1).toContain('\\usepackage{tikz}');
    expect(w1).toContain('\\newenvironment{olbox}');
    const again = parseTex(w1, opts).doc;
    expect(writeTex(again, opts).text).toBe(w1);
    const node = lyxToPmNode(again);
    expect(node.child(0).type.name).toBe('ol_page');
    expect(writeTex({ ...again, body: pmToLyxBody(node) }, opts).text).toBe(w1);
  });
  it('leaves a beamer frame without layout objects to beamer\'s Frame layout', () => {
    const { doc } = parseTex('\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{Title}\nText\n\\end{frame}\n\\end{document}\n', opts);
    expect(doc.body.some(p => p.layout === 'OLPage')).toBe(false);
  });
  it('the macro package compiles-in the managed block with its keys', () => {
    for (const k of ['olbox', 'olshape', 'olimage', 'olgroup', 'olraw', 'olpage', 'svg.path', 'adjincludegraphics']) expect(LAYOUT_MACROS).toContain(k);
  });
});

describe('templates of new layout documents', () => {
  for (const p of PAGE_PRESETS) {
    it(`${p.label}: parses, has its page size, writes stably`, () => {
      const t = layoutTemplate(p.id, { title: 'My talk', author: 'A & B' });
      const doc = parseTex(t.text, opts).doc;
      const before = [...doc.header.lines];
      for (const [k, v] of Object.entries(t.settings)) setHeaderValue(doc.header, k, v);
      doc.header.lines = markEditedSettings(before, doc.header.lines, Object.keys(t.settings));
      const text = writeTex(doc, opts).text;
      const back = parseTex(text, opts).doc;
      expect(pageSizeOf(back.header.lines)).toEqual({ w: p.w, h: p.h });
      expect(back.body.filter(x => x.layout === 'OLPage').length).toBeGreaterThan(0);
      expect(writeTex(back, opts).text).toBe(text);
      if (p.kind !== 'page') expect(text).toContain('A \\& B');
    });
  }
});

describe('font sizes', () => {
  it('reads \\fontsize…\\selectfont as an absolute size and writes it back', () => {
    const src = '\\documentclass{article}\n\\begin{document}\nA {\\fontsize{14}{16.8}\\selectfont b} {\\fontsize{25}{33.5}\\selectfont c} {\\small $x$}.\n\\end{document}\n';
    const { doc } = parseTex(src, opts);
    const sizes = doc.body[0].items.map(i => i.font.size ?? null).filter(Boolean);
    expect(sizes).toEqual(['14pt', '25pt/33.5pt', 'small']);
    const w = writeTex(doc, opts).text;
    expect(w).toContain('{\\fontsize{14}{16.8}\\selectfont b}');
    expect(w).toContain('{\\fontsize{25}{33.5}\\selectfont c}');
    expect(w).toContain('{\\small $x$}');
  });
  it('beamer\'s \\textbf without an overlay is bold text, not a Bold inset', () => {
    const { doc } = parseTex('\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}\nsome \\textbf{bold} and \\textbf<2>{later}\n\\end{frame}\n\\end{document}\n', opts);
    const items = doc.body.flatMap(p => p.items);
    expect(items.some(i => i.kind === 'text' && i.text === 'bold' && i.font.series === 'bold')).toBe(true);
    expect(items.some(i => i.kind === 'inset' && i.inset.type === 'Text' && i.inset.name === 'Flex')).toBe(true);
  });
});

describe('build paths', () => {
  it('rewrites paths that leave the document\'s folder as project paths', () => {
    const proj = '/p/proj', dir = '/p/proj/poster';
    const src = '\\input{../macros}\n\\graphicspath{{../}{../figures/}}\n\\includegraphics[width=2cm]{../logos/a}\n\\olimage{x=1mm,y=1mm}{../figures/b.pdf}\n\\input{local}\n\\input{../../outside}';
    const out = rewriteParentPaths(src, dir, proj);
    expect(out).toBe('\\input{macros}\n\\graphicspath{{}{figures/}}\n\\includegraphics[width=2cm]{logos/a}\n\\olimage{x=1mm,y=1mm}{figures/b.pdf}\n\\input{local}\n\\input{../../outside}');
  });
});
