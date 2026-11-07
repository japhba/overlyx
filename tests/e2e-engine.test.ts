// The engine an end-to-end encrypted project's PDF is built with in the browser (client e2e/compile.ts):
// the server's choice (export.ts), except that non-TeX fonts go to LuaLaTeX there.
import { describe, it, expect } from 'vitest';
import { engineOf } from '../packages/client/src/e2e/compile.ts';

const header = (...lines: string[]) => ({ lines });

describe('engineOf', () => {
  it('builds markdown with LuaLaTeX and plain LaTeX with pdfLaTeX', () => {
    expect(engineOf('notes.md', '', null)).toBe('luahbtex');
    expect(engineOf('main.tex', '\\documentclass{article}', header())).toBe('pdftex');
  });

  it('follows a magic comment', () => {
    expect(engineOf('main.tex', '% !TeX program = xelatex\n\\documentclass{article}', header())).toBe('xetex');
    expect(engineOf('main.tex', '%!TEX TS-program = lualatex-dev\n', header())).toBe('luahbtex');
    expect(engineOf('main.tex', '% !TeX program = pdflatex\n', header('\\use_non_tex_fonts true'))).toBe('pdftex');
  });

  it('takes the output format and fonts from the header and text', () => {
    expect(engineOf('main.tex', '', header('\\default_output_format pdf5'))).toBe('luahbtex');
    expect(engineOf('main.tex', '', header('\\default_output_format pdf4'))).toBe('xetex');
    expect(engineOf('main.tex', 'x \\olfont{Inter}{y}', header())).toBe('luahbtex');
  });

  it('builds non-TeX fonts with LuaLaTeX, which finds fonts by name in the browser', () => {
    expect(engineOf('main.tex', '', header('\\use_non_tex_fonts true'))).toBe('luahbtex');
    expect(engineOf('main.tex', '', header('\\use_non_tex_fonts true', '\\default_output_format pdf4'))).toBe('luahbtex');
  });
});
