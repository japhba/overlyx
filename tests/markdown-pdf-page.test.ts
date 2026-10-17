/** Markdown's PDF: pandoc's page variables in the front matter set the page (core/md/latex.ts). */
import { describe, it, expect } from 'vitest';
import { parseMarkdown, markdownForLatex } from '../packages/core/src/md/index.ts';
import { frontMatterVars } from '../packages/core/src/md/latex.ts';
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
});
