/** Markdown's PDF: pandoc's page variables in the front matter set the page (core/md/latex.ts). */
import { describe, it, expect } from 'vitest';
import { parseMarkdown, markdownForLatex } from '../packages/core/src/md/index.ts';
import { frontMatterVars, mdTypesetting, setFrontMatter, MD_FONTS } from '../packages/core/src/md/typesetting.ts';
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
    expect(doc.header.lines).toContain('\\overlyx_headings run-in');
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
