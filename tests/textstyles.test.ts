/**
 * Text styles (core textstyles.ts): the model, its LaTeX for markdown and .tex documents, and the
 * hand-written LaTeX the editor reads (an agent's header-includes) — taken over when a style is edited.
 */
import { describe, it, expect } from 'vitest';
import { parseStyles, stylesJson, stylesLatex, stylesFromIncludes, takeOverIncludes, textStyleOf } from '../packages/core/src/textstyles.ts';
import { parseMarkdown } from '../packages/core/src/md/index.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';

describe('text styles', () => {
  it('keep what is valid', () => {
    expect(textStyleOf({ size: '14pt', color: '1F4E79', align: 'right', 'space-above': '6pt', font: 'Inter|300', weight: 'heavy', rule: 'below' }))
      .toEqual({ size: '14pt', color: '#1f4e79', align: 'right', spaceAbove: '6pt', font: 'Inter|300', rule: 'below' });
    expect(textStyleOf({ size: '900pt', font: 'x}\\bad' })).toEqual({});
    expect(parseStyles(stylesJson({ title: { size: 'large' }, body: {} }))).toEqual({ title: { size: 'large' } });
  });

  it('become titlesec, titling, etoolbox and the body colour in LaTeX', () => {
    const tex = stylesLatex({ section: { size: '13pt', color: '#1f4e79', align: 'center', font: 'Inter|300' }, title: { size: 'large', align: 'left', case: 'uppercase' }, quote: { shape: 'italic' }, body: { color: '#222222' } }).join('\n');
    expect(tex).toContain('\\titleformat{\\section}[block]{\\normalfont\\olfontset[300]{Inter}\\fontsize{13}{15.6}\\selectfont\\bfseries\\color[HTML]{1F4E79}\\filcenter}');
    expect(tex).toContain('\\pretitle{\\begin{flushleft}\\large\\MakeUppercase}');
    expect(tex).toContain('\\AtBeginEnvironment{quote}{\\itshape}');
    expect(tex).toContain('\\AtBeginDocument{\\color[HTML]{222222}}');
  });

  it('are read from LaTeX written by hand, for the editor, and take over from it when edited', () => {
    const includes = ['\\usepackage{titlesec}', '\\usepackage{ragged2e}', '\\AtBeginDocument{\\justifying}',
      '\\titleformat{\\section}[block]{\\normalfont\\small\\bfseries}{\\thesection}{0.6em}{}', '\\titlespacing{\\section}{0pt}{1.4ex plus .2ex}{0.8ex}',
      '\\makeatletter\\patchcmd{\\@maketitle}{\\LARGE}{\\large}{}{}\\makeatother'];
    const r = stylesFromIncludes(includes);
    expect(r.justify).toBe(true);
    expect(r.styles.section).toEqual({ display: 'block', size: 'small', weight: 'bold', spaceAbove: '1.4ex', spaceBelow: '0.8ex' });
    expect(r.styles.title).toEqual({ size: 'large' });
    expect(takeOverIncludes(includes, ['section', 'body'])).toEqual(['\\usepackage{titlesec}', '\\makeatletter\\patchcmd{\\@maketitle}{\\LARGE}{\\large}{}{}\\makeatother']);
    // the editor sees them: a markdown document's header
    const { doc } = parseMarkdown('---\nheader-includes:\n' + includes.map(l => `  - "${l}"`).join('\n') + '\n---\n\nText.\n');
    expect(doc.header.lines).toContain('\\overlyx_justify true');
    expect(JSON.parse(doc.header.lines.find(l => l.startsWith('\\overlyx_styles '))!.slice(16)).section.size).toBe('small');
  });

  it('of a .tex document are its settings, written into the managed block', () => {
    const { doc } = parseTex('\\documentclass{article}\n\\begin{document}\n\\section{A}\nText.\n\\end{document}\n');
    doc.header.lines.push('\\overlyx_styles ' + stylesJson({ section: { color: '#c0392b', font: 'Inter' } }));
    const text = writeTex(doc, { basename: 'x' }).text;
    expect(text).toContain('"overlyx_styles":');
    expect(text).toContain('\\titleformat{\\section}[hang]{\\normalfont\\olfontset{Inter}\\Large\\bfseries\\color[HTML]{C0392B}}');
    expect(text).toContain('\\DeclareDocumentCommand \\olfontset');
    // read back: the same settings, the same file
    const again = parseTex(text).doc;
    expect(again.header.lines.find(l => l.startsWith('\\overlyx_styles '))).toBe(doc.header.lines.find(l => l.startsWith('\\overlyx_styles ')));
    expect(writeTex(again, { basename: 'x' }).text).toBe(text);
  });
});

describe('front matter values', () => {
  it('read back as written: YAML escapes undone, a lone backslash kept', async () => {
    const { frontMatterVars, setFrontMatter } = await import('../packages/core/src/md/typesetting.ts');
    const lines = ['---', 'header-includes:', '  - "\\usepackage{titlesec}"', '---'];
    expect(frontMatterVars(lines)['header-includes']).toEqual(['\\usepackage{titlesec}']);
    const again = setFrontMatter(lines, { 'header-includes': ['\\usepackage{titlesec}', 'say "hi"'] });
    expect(frontMatterVars(again)['header-includes']).toEqual(['\\usepackage{titlesec}', 'say "hi"']);
  });
});
