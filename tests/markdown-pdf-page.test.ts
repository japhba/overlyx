/** Markdown's PDF: pandoc's page variables in the front matter set the page (core/md/latex.ts). */
import { describe, it, expect } from 'vitest';
import { parseMarkdown, markdownForLatex } from '../packages/core/src/md/index.ts';
import { frontMatterVars, mdTypesetting, setFrontMatter, headingStyles, MD_FONTS } from '../packages/core/src/md/typesetting.ts';
import { writeTex } from '../packages/core/src/tex/write.ts';

const preambleOf = (md: string) => writeTex(markdownForLatex(parseMarkdown(md).doc), { basename: 'x' }).text.split('\\begin{document}')[0];

describe('markdown PDF page settings', () => {
  it('takes pandoc\'s geometry, papersize, fontsize, linestretch and header-includes', () => {
    const pre = preambleOf('---\ntitle: T\npapersize: a4\nfontsize: 11pt\nlinestretch: 1.25\ngeometry:\n  - margin=2cm\n  - top=1.5cm\nheader-includes:\n  - \\usepackage{xcolor}\n---\n\n# Hello\n');
    expect(pre).toContain('\\documentclass[11pt,a4paper]{article}');
    expect(pre).toContain('\\usepackage[margin=2cm,top=1.5cm]{geometry}');
    expect(pre).toContain('\\usepackage{xcolor}');
    expect(pre).toContain('\\setstretch{1.25}');
  });

  it('escapes link text (file names with underscores, autolinks), keeps formulas in it', () => {
    const body = writeTex(markdownForLatex(parseMarkdown('[a_b.tex](a_b.tex) <https://x.org/a_b#c> [$x_1$ & 5%](https://x.org)\n').doc), { basename: 'x' }).text;
    expect(body).toContain('\\href{a_b.tex}{a\\_b.tex}');
    expect(body).toContain('\\href{https://x.org/a_b\\#c}{https://x.org/a\\_b\\#c}');
    expect(body).toContain('\\href{https://x.org}{$x_1$ \\& 5\\%}');
  });

  it('reads the forms pandoc users write; a document without front matter keeps the article defaults', () => {
    expect(frontMatterVars(['---', 'geometry: "margin=1in, left=2in"', 'papersize: letter', '...'])).toEqual({ geometry: 'margin=1in, left=2in', papersize: 'letter' });
    expect(frontMatterVars(['---', 'geometry: [margin=1in, top=2cm]', '---'])).toEqual({ geometry: ['margin=1in', 'top=2cm'] });
    expect(frontMatterVars(['---', 'header-includes: |', '  \\usepackage{a}', '  \\usepackage{b}', '---'])).toEqual({ 'header-includes': ['\\usepackage{a}', '\\usepackage{b}'] });
    expect(frontMatterVars(['---', 'header-includes:', '  - |', '    ```{=latex}', '    \\usepackage{c}', '    ```', '---'])).toEqual({ 'header-includes': ['\\usepackage{c}'] });
    expect(preambleOf('---\ngeometry: margin=1in, left=2in\n---\n\nText\n')).toContain('\\usepackage[margin=1in,left=2in]{geometry}');
    // (geometry options with braces or commands are left out: those go in header-includes)
    expect(preambleOf('---\ngeometry: margin={1in}\n---\n\nText\n')).not.toContain('geometry');
    const plain = preambleOf('# Hello\n\nText\n');
    expect(plain).toContain('\\documentclass{article}');
    expect(plain).not.toContain('geometry');
  });

  it('fonts, math, numbering and run-in headings: the settings the editor reads, and the PDF\'s preamble', () => {
    const md = '---\nmainfont: Libertinus Serif\nmathfont: Libertinus Math\nnumbersections: true\nheadings: run-in\n---\n\n# Background\n\nText.\n';
    const { doc } = parseMarkdown(md);
    // the header the editor gets: fonts, section numbers, run-in headings
    expect(doc.header.lines).toContain('\\use_non_tex_fonts true');
    expect(doc.header.lines).toContain('\\font_roman "default" "Libertinus Serif"');
    expect(doc.header.lines).toContain('\\secnumdepth 3');
    expect(JSON.parse(doc.header.lines.find(l => l.startsWith('\\overlyx_styles '))!.slice(16)).section).toEqual({ display: 'run-in' });
    const pre = preambleOf(md);
    expect(pre).toMatch(/\\usepackage\{amsmath\}\n\\usepackage\{unicode-math\}\n\\setmathfont\{Libertinus Math\}/);
    expect(pre).toContain('\\setmainfont[Ligatures=TeX]{Libertinus Serif}');
    expect(pre).toContain('\\titleformat{\\section}[runin]');
    // a name that is not a font name is not written into the LaTeX
    expect(mdTypesetting(['---', 'mainfont: "x}\\input{/etc/passwd"', '---']).mainfont).toBe('');
    expect(MD_FONTS.every(f => f.main && f.math)).toBe(true);
  });

  it('the settings dialog writes keys into the front matter and leaves the rest as it was', () => {
    const fm = ['---', 'title: My notes', '# a comment', 'geometry:', '  - left=2cm', '  - top=1cm', 'tags: [a, b]', '---'];
    expect(setFrontMatter(fm, { geometry: 'margin=2cm', mainfont: 'STIX Two Text', mathfont: 'STIX Two Math', headings: 'run-in', numbersections: true }))
      .toEqual(['---', 'title: My notes', '# a comment', 'geometry: margin=2cm', 'tags: [a, b]', 'mainfont: STIX Two Text', 'mathfont: STIX Two Math', 'headings: run-in', 'numbersections: true', '---']);
    expect(setFrontMatter(fm, { geometry: null })).toEqual(['---', 'title: My notes', '# a comment', 'tags: [a, b]', '---']);
    // none yet: one is made; nothing left: it goes
    expect(setFrontMatter([], { fontsize: '11pt' })).toEqual(['---', 'fontsize: 11pt', '---']);
    expect(setFrontMatter(['---', 'fontsize: 11pt', '---'], { fontsize: null })).toEqual([]);
    // values YAML would read as something else are quoted
    expect(setFrontMatter([], { headings: 'yes' })).toEqual(['---', 'headings: "yes"', '---']);
  });
});


describe('markdown typesetting changes', () => {
  it('recomputes the settings from the front matter, back to a markdown document\'s when a key goes', async () => {
    const { withTypesetting } = await import('../packages/core/src/md/typesetting.ts');
    const { doc } = parseMarkdown('---\nmainfont: XITS\nnumbersections: true\nheadings: run-in\n---\n\nText\n');
    const after = withTypesetting(doc.header.lines, ['---', 'fontsize: 12pt', '---']);
    expect(after).toContain('\\use_non_tex_fonts false');
    expect(after).toContain('\\secnumdepth -1');
    expect(after).toContain('\\paperfontsize 12');
    expect(after.some(l => l.startsWith('\\overlyx_headings'))).toBe(false);
    expect(after.find(l => l.startsWith('\\font_roman'))).toBe('\\font_roman "default" "default"');
  });
});

describe('heading styles (headings: in the front matter)', () => {
  const fm = ['---', 'title: x', 'headings:', '  display: run-in', '  font: Fira Sans', '  color: "#1F4E79"', '  case: smallcaps', '  section:', '    display: block', '    size: larger', '    rule: below', '  subsection: { shape: italic, align: center }', 'mainfont: XITS', '---'];
  it('reads keys of their own, nested or as { … }, next to the plain ones', () => {
    expect(frontMatterVars(fm)).toEqual({ title: 'x', mainfont: 'XITS', headings: { display: 'run-in', font: 'Fira Sans', color: '#1F4E79', case: 'smallcaps', section: { display: 'block', size: 'larger', rule: 'below' }, subsection: { shape: 'italic', align: 'center' } } });
  });
  it('every level takes the keys for all, then its own; unknown values are left out', () => {
    const h = headingStyles(frontMatterVars(fm).headings)!;
    expect(h.section).toEqual({ display: 'block', font: 'Fira Sans', color: '#1f4e79', case: 'smallcaps', size: 'larger', rule: 'below' });
    expect(h.paragraph).toEqual({ display: 'run-in', font: 'Fira Sans', color: '#1f4e79', case: 'smallcaps' });
    expect(headingStyles({ size: 'gigantic', color: 'red', font: 'x}\\bad' })).toBeNull();
    expect(headingStyles('run-in')!.subsection).toEqual({ display: 'run-in' });
    expect(headingStyles(undefined)).toBeNull();
  });
  it('becomes titlesec in the PDF', () => {
    const pre = preambleOf(fm.join('\n') + '\n\n# A\n\nText.\n');
    // (the heading font by name: \olfontset, defined in the preamble — core fontface.ts)
    expect(pre).toContain('\\DeclareDocumentCommand \\olfontset');
    expect(pre).toContain('\\titleformat{\\section}[hang]{\\normalfont\\olfontset{Fira Sans}\\Large\\bfseries\\scshape\\color[HTML]{1F4E79}}{\\thesection}{1em}{}[\\vspace{.4ex}\\titlerule]');
    // (the subsection runs in, as all levels but the section do: a run-in heading is not centred)
    expect(pre).toContain('\\titleformat{\\subsection}[runin]{\\normalfont\\olfontset{Fira Sans}\\normalsize\\bfseries\\itshape\\scshape\\color[HTML]{1F4E79}}');
    expect(pre).toContain('\\titleformat{\\subsubsection}[runin]{\\normalfont\\olfontset{Fira Sans}\\normalsize\\bfseries\\scshape\\color[HTML]{1F4E79}}');
  });
  it('is written back as keys of their own', () => {
    expect(setFrontMatter(['---', 'title: x', 'headings: run-in', '---'], { headings: { display: 'block', color: '#336699', section: { size: 'huge' } } }))
      .toEqual(['---', 'title: x', 'headings:', '  display: block', '  color: "#336699"', '  section:', '    size: huge', '---']);
  });

  it('space above and below a heading: kept to in the PDF, the editor too', () => {
    const fm = ['---', 'headings:', '  space-below: 0.4ex', '  section: { space-above: 2, space-below: 3pt }', '  subsection: { space-below: lots }', '---'];
    const h = headingStyles(frontMatterVars(fm).headings)!;
    expect(h.section).toEqual({ spaceAbove: '2em', spaceBelow: '3pt' });
    expect(h.subsection).toEqual({ spaceBelow: '0.4ex' });
    const pre = preambleOf(fm.join('\n') + '\n\n# A\n\nText.\n');
    expect(pre).toContain('\\titlespacing*{\\section}{0pt}{2em plus .2ex}{3pt}');
    expect(pre).toContain('\\titlespacing*{\\subsection}{0pt}{3.25ex plus 1ex minus .2ex}{0.4ex}');
  });

  it('justify: justified text in the PDF and the editor; ragged right without, as before', () => {
    const on = preambleOf('---\njustify: true\n---\n\nText.\n');
    // (justified is LaTeX's own way: the ragged-right setting just goes)
    expect(on).not.toContain('\\RaggedRight');
    expect(preambleOf('Text.\n')).toContain('\\RaggedRight');
    const { doc } = parseMarkdown('---\njustify: true\n---\n\nText.\n');
    expect(doc.header.lines).toContain('\\overlyx_justify true');
  });

  it('a body font the build has as files (a Google font) is loaded by file, and named nowhere else; a heading font by name', () => {
    const md = '---\nmainfont: Lora\nheadings: { font: Inter }\n---\n\n# A\n\nText.\n';
    const tex = writeTex(markdownForLatex(parseMarkdown(md).doc, { fontFiles: {
      Lora: { path: './ol-fonts/lora/', regular: 'lora-400.ttf', bold: 'lora-700.ttf', italic: 'lora-400i.ttf', boldItalic: 'lora-700i.ttf' },
      Inter: { path: './ol-fonts/inter/', regular: 'inter-400.ttf' },
    } }), { basename: 'x' }).text;
    expect(tex).toContain('\\setmainfont{Lora}[Path=./ol-fonts/lora/, UprightFont=lora-400.ttf, BoldFont=lora-700.ttf, ItalicFont=lora-400i.ttf, BoldItalicFont=lora-700i.ttf, Ligatures=TeX]');
    // (the heading's: by name — the build puts the Google fonts \olfontset names where LuaTeX finds them, OSFONTDIR)
    expect(tex).toContain('\\titleformat{\\section}[hang]{\\normalfont\\olfontset{Inter}\\Large\\bfseries}');
    expect(tex).not.toContain('\\setmainfont[Ligatures=TeX]{Lora}');
  });
});

