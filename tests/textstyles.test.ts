/**
 * Text styles (core textstyles.ts): the model, its LaTeX for markdown and .tex documents, and the
 * preamble's own LaTeX — read for the editor, given the last word in the PDF, replaced when the same
 * thing is set in the style editor.
 */
import { describe, it, expect } from 'vitest';
import {
  parseStyles, stylesJson, stylesLatex, textStyleOf, readTexStyles, pdfStyles, takeOver, removeStatements, styleLayers, bodyFace,
} from '../packages/core/src/textstyles.ts';
import { parseMarkdown, markdownForLatex } from '../packages/core/src/md/index.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';

describe('text styles', () => {
  it('keep what is valid; a weight is 1 … 1000, and a font by name gives its weight to the style', () => {
    expect(textStyleOf({ size: '14pt', color: '1F4E79', align: 'right', 'space-above': '6pt', font: 'Inter|300', weight: 'heavy', rule: 'below', 'line-spacing': 1.5 }))
      .toEqual({ size: '14pt', color: '#1f4e79', align: 'right', spaceAbove: '6pt', font: 'Inter', weight: 300, rule: 'below', lineSpacing: 1.5 });
    expect(textStyleOf({ weight: 'bold', font: '@sans' })).toEqual({ weight: 700, font: '@sans' });
    expect(textStyleOf({ font: 'Inter|wght=350,opsz=32|+onum' })).toEqual({ font: 'Inter|opsz=32|+onum', weight: 350 });
    expect(textStyleOf({ size: '900pt', font: 'x}\\bad' })).toEqual({});
    expect(parseStyles(stylesJson({ title: { size: 'large' }, body: {} }))).toEqual({ title: { size: 'large' } });
  });

  it('become titlesec, titling, etoolbox and the body colour in LaTeX; weights as the font has them', () => {
    const tex = stylesLatex({ section: { size: '13pt', color: '#1f4e79', align: 'center', font: 'Inter', weight: 300 }, subsection: { weight: 600, font: '@sans' }, title: { size: 'large', align: 'left', case: 'uppercase' }, quote: { shape: 'italic' }, body: { color: '#222222' } }).join('\n');
    expect(tex).toContain('\\titleformat{\\section}[block]{\\normalfont\\olfontset[300]{Inter}\\fontsize{13}{15.6}\\selectfont\\color[HTML]{1F4E79}\\filcenter}');
    // (the document's own font: its series)
    expect(tex).toContain('\\titleformat{\\subsection}[hang]{\\normalfont\\sffamily\\large\\bfseries}');
    expect(tex).toContain('\\pretitle{\\begin{flushleft}\\large\\MakeUppercase}');
    expect(tex).toContain('\\AtBeginEnvironment{quote}{\\itshape}');
    expect(tex).toContain('\\AtBeginDocument{\\color[HTML]{222222}}');
    // a weight of the body's font by name (a heading of no font of its own takes it)
    expect(stylesLatex({ section: { weight: 500 } }, { bodyFont: 'Lora' }).join('\n')).toContain('\\normalfont\\olfontset[500]{Lora}\\Large}');
    expect(bodyFace({ font: 'Lora||+onum', weight: 450 })).toBe('\\olmainfont[450][+onum]{Lora}');
    expect(bodyFace({ font: 'Lora' })).toBeNull();
  });
});

describe('the preamble’s own LaTeX', () => {
  const includes = ['\\usepackage{titlesec}', '\\usepackage{ragged2e}', '\\AtBeginDocument{\\justifying}', '\\usepackage[onehalfspacing]{setspace}',
    '\\titleformat{\\section}[block]{\\normalfont\\small\\bfseries}{\\thesection}{0.6em}{}', '\\titlespacing{\\section}{0pt}{1.4ex plus .2ex}{0.8ex}',
    '\\makeatletter\\patchcmd{\\@maketitle}{\\LARGE}{\\large}{}{}\\makeatother', '% \\titleformat{\\subsection}{\\Huge}{}{0pt}{}',
    '\\newcommand{\\note}[1]{\\raggedright #1}'].join('\n');

  it('is read: what it sets, as far as it can be read — not in comments or someone else’s definitions', () => {
    const tex = readTexStyles(includes);
    expect(tex.body?.set).toEqual({ align: 'justify', lineSpacing: 1.25 });
    // (a format given whole: what it does not say is the plain text's)
    expect(tex.section?.set).toEqual({ display: 'block', size: 'small', weight: 700, align: 'left', spaceAbove: '1.4ex', spaceBelow: '0.8ex' });
    expect(tex.title?.set).toEqual({ size: 'large' });
    expect(tex.subsection).toBeUndefined();
    // the PDF: the document's styles under it
    const pdf = pdfStyles({ section: { color: '#ff0000', size: 'huge' }, subsection: { color: '#00ff00' } }, tex);
    expect(pdf.section).toEqual(tex.section?.set);
    expect(pdf.subsection).toEqual({ color: '#00ff00' });
  });

  it('is replaced when the same is set here: its statements go, what they set stays in the document', () => {
    const tex = readTexStyles(includes);
    const size = takeOver(tex, 'section', 'size');
    expect(size.statements.map(s => s.text)).toEqual(['\\titleformat{\\section}[block]{\\normalfont\\small\\bfseries}{\\thesection}{0.6em}{}']);
    expect(size.keep.section).toEqual({ display: 'block', size: 'small', weight: 700, align: 'left' });
    const all = [...takeOver(tex, 'body').statements, ...takeOver(tex, 'title').statements];
    expect(removeStatements(includes, all).split('\n')).toEqual(['\\usepackage{titlesec}', '\\usepackage{ragged2e}', '\\usepackage{setspace}',
      '\\titleformat{\\section}[block]{\\normalfont\\small\\bfseries}{\\thesection}{0.6em}{}', '\\titlespacing{\\section}{0pt}{1.4ex plus .2ex}{0.8ex}',
      '% \\titleformat{\\subsection}{\\Huge}{}{0pt}{}', '\\newcommand{\\note}[1]{\\raggedright #1}']);
  });

  it('has the last word in a markdown document’s PDF; the editor sees it', () => {
    const md = '---\nheadings:\n  section: { color: "#336699" }\n  subsection: { color: "#336699" }\nheader-includes:\n' + includes.split('\n').map(l => `  - "${l.replace(/\\/g, '\\\\')}"`).join('\n') + '\n---\n\nText.\n';
    const { doc } = parseMarkdown(md);
    const layers = styleLayers(doc.header.lines);
    expect(layers.document.section).toEqual({ color: '#336699' });
    expect(layers.pdf.section?.size).toBe('small');
    expect(layers.pdf.body?.align).toBe('justify');
    const tex = writeTex(markdownForLatex(doc), { basename: 'x' }).text;
    // OverLyX's own format for the section is left out (the preamble's is the PDF's); the subsection's is there
    expect(tex).not.toContain('\\titleformat{\\section}[hang]');
    expect(tex).toContain('\\titleformat{\\subsection}[hang]{\\normalfont\\large\\bfseries\\color[HTML]{336699}}');
    // \justifying is the preamble's: no \RaggedRight after it
    expect(tex).not.toContain('\\RaggedRight');
  });

  it('has the last word in a .tex document’s PDF; the managed block writes the rest', () => {
    const src = '\\documentclass{article}\n\\usepackage{titlesec}\n\\titleformat{\\section}{\\normalfont\\itshape}{\\thesection}{1em}{}\n\\begin{document}\n\\section{A}\nText.\n\\end{document}\n';
    const { doc } = parseTex(src);
    doc.header.lines.push('\\overlyx_styles ' + stylesJson({ section: { color: '#c0392b', font: 'Inter' }, subsection: { color: '#c0392b' } }));
    const text = writeTex(doc, { basename: 'x' }).text;
    expect(text).toContain('"overlyx_styles":');
    expect(text.match(/\\titleformat\{\\section\}/g)).toHaveLength(1);
    expect(text).toContain('\\titleformat{\\subsection}[hang]{\\normalfont\\large\\bfseries\\color[HTML]{C0392B}}');
    // read back: the same settings, the same file
    const again = parseTex(text).doc;
    expect(again.header.lines.find(l => l.startsWith('\\overlyx_styles '))).toBe(doc.header.lines.find(l => l.startsWith('\\overlyx_styles ')));
    expect(writeTex(again, { basename: 'x' }).text).toBe(text);
    expect(styleLayers(again.header.lines).pdf.section).toEqual({ display: 'block', shape: 'italic', size: 'normal', weight: 400, align: 'left' });
  });

  it('a .tex document’s body font by name with a weight and features: \\olmainfont', () => {
    const { doc } = parseTex('\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n');
    const set = (k: string, v: string) => { const i = doc.header.lines.findIndex(l => l.startsWith(`\\${k} `)); if (i >= 0) doc.header.lines[i] = `\\${k} ${v}`; else doc.header.lines.push(`\\${k} ${v}`); };
    set('use_non_tex_fonts', 'true');
    set('font_roman', '"default" "Lora"');
    doc.header.lines.push('\\overlyx_styles ' + stylesJson({ body: { font: 'Lora||+onum', weight: 450 } }));
    const text = writeTex(doc, { basename: 'x' }).text;
    expect(text).toContain('\\olmainfont[450][+onum]{Lora}');
    expect(text).not.toContain('\\setmainfont[');
    expect(text).toContain('\\DeclareDocumentCommand \\olmainfont');
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
