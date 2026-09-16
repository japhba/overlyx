import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { macrosFromLatex, sanitizeForMathlive, toMathliveMacros } from '../packages/core/src/macros.ts';
import { katexMacros, sanitizeForKatex } from '../packages/core/src/math/katex.ts';
import { isBenignBrowserError } from '../packages/client/src/error-reporting.ts';
import { renderStaticHtml } from '../packages/client/src/editor/lyxmath/field.ts';
import type { MacroTable } from '../packages/core/src/math/ast.ts';

describe('GitHub bug reports', () => {
  it('#4 renders a minimal image-based macro instead of its literal name', () => {
    const def = String.raw`\mathord{\includegraphics[height=0.7em]{glyph.pdf}}`;
    const sanitized = sanitizeForKatex(def, 'Pfi', 0);
    expect(sanitized).toContain('lm-image-glyph');
    expect(sanitizeForKatex(sanitized, 'Pfi', 0)).toBe(sanitized);
    const macros: MacroTable = { Pfi: { nargs: 0, def: sanitized }, tPfi: { nargs: 0, def: String.raw`\tilde{\Pfi}` } };
    const html = renderStaticHtml('$\\Pfi_{ij},\\quad\\tPfi_{ij}$', false, macros, { project: 'paper', docDir: 'chapters' });
    expect(html).toContain('<img');
    expect(html).toMatch(/src="\/api\/projects\/paper\/graphics\/chapters(?:\/|%2F)glyph\.pdf\?w=400"/);
    expect(html).not.toContain('>Pfi<');
  });

  it('#4 approximates the font-height/raisebox/includesvg form used by the reported macro', () => {
    const source = String.raw`\NewDocumentCommand{\myPfi}{}{\text{\normalfont \bbheight=\fontcharht\font@0 \raisebox{-0.04\bbheight}[\bbheight][0pt]{\includesvg[height=1.08\bbheight]{doublephi.svg}}}}`.replace('@', '`');
    const defs = macrosFromLatex(source).macros;
    const transported = toMathliveMacros(defs);
    expect(transported.myPfi.def).toContain(String.raw`\includegraphics[height=0.696em]{doublephi.svg}`);
    expect(transported.myPfi.def).not.toMatch(/fontcharht|raisebox|includesvg/);
    const macros: MacroTable = { myPfi: { nargs: 0, def: transported.myPfi.def } };
    expect(() => katex.renderToString(String.raw`\myPfi`, { throwOnError: true, strict: false, trust: true, macros: katexMacros(macros) })).not.toThrow();
    expect(sanitizeForKatex(transported.myPfi.def, 'myPfi', 0)).toBe(transported.myPfi.def);
    expect(sanitizeForKatex(defs[0].def, 'myPfi', 0)).toBe(transported.myPfi.def);
    for (const formula of [String.raw`\myPfi`, String.raw`x_{\myPfi}`, String.raw`x^{\myPfi}`, String.raw`x_{x_{\myPfi}}`]) {
      const html = renderStaticHtml(formula, false, macros, { project: 'paper', docDir: 'chapters' });
      // The image height is relative to its current font in all three math sizes.
      expect(html).toMatch(/<img[^>]*style="height:0\.696em;/);
      expect(decodeURIComponent(html)).toContain('mask-image:url(&quot;/api/projects/paper/graphics/chapters/doublephi.svg?w=400&quot;)');
      expect(html).not.toMatch(/katex-error|lm-error/);
    }
  });

  it('renders the alignment glyph through both macro passes, including accents and scripts', () => {
    const source = String.raw`\DeclareRobustCommand{\doublephi}{\mathord{\mathchoice
      {\includegraphics[height=0.68333em]{symbols/doublephi.pdf}}
      {\includegraphics[height=0.68333em]{symbols/doublephi.pdf}}
      {\includegraphics[height=0.47833em]{symbols/doublephi.pdf}}
      {\includegraphics[height=0.34167em]{symbols/doublephi.pdf}}}}
      \def\Pfi{\doublephi}\def\tPfi{\tilde{\Pfi}}`;
    const transported = toMathliveMacros(macrosFromLatex(source).macros);
    const macros: MacroTable = Object.fromEntries(Object.entries(transported).map(([name, value]) => [name, { nargs: value.args, def: value.def }]));
    for (const formula of [String.raw`\Pfi`, String.raw`\tPfi`, String.raw`x_{\Pfi}`, String.raw`x_{x_{\Pfi}}`]) {
      const html = renderStaticHtml(formula, false, macros, { project: 'paper', docDir: '' });
      expect(html).toMatch(/<img[^>]*style="height:0\.6833\d*em;/);
      expect(html).toContain('mask-image:');
      expect(html).not.toMatch(/katex-error|lm-error|lm-unknown|>doublephi</);
    }
  });

  it('preserves image-glyph baseline shifts through both macro passes', () => {
    const source = String.raw`\DeclareRobustCommand{\doublephi}{\mathord{\mathchoice
      {\raisebox{-0.02756em}{\includegraphics[height=0.744em]{symbols/doublephi.pdf}}}
      {\raisebox{-0.02756em}{\includegraphics[height=0.744em]{symbols/doublephi.pdf}}}
      {\raisebox{-0.01929em}{\includegraphics[height=0.5208em]{symbols/doublephi.pdf}}}
      {\raisebox{-0.01378em}{\includegraphics[height=0.372em]{symbols/doublephi.pdf}}}}}
      \def\Pfi{\doublephi}\def\tPfi{\tilde{\Pfi}}`;
    const transported = toMathliveMacros(macrosFromLatex(source).macros);
    const macros: MacroTable = Object.fromEntries(Object.entries(transported).map(([name, value]) => [name, { nargs: value.args, def: value.def }]));
    expect(sanitizeForKatex(transported.doublephi.def, 'doublephi', 0)).toBe(transported.doublephi.def);
    const bare = katex.renderToString(String.raw`\Pfi`, { output: 'html', throwOnError: true, strict: false, trust: true, macros: katexMacros(macros) });
    expect(bare).toContain('height:0.744em;vertical-align:-0.0276em;');
    for (const formula of [String.raw`\Pfi`, String.raw`\tPfi`, String.raw`x_{\Pfi}`, String.raw`x^{\Pfi}`, String.raw`x_{x_{\Pfi}}`]) {
      const html = renderStaticHtml(formula, false, macros, { project: 'paper', docDir: '' });
      expect(html).toContain('mask-image:');
      expect(html).not.toMatch(/katex-error|lm-error|lm-unknown|>doublephi</);
    }
    const raised = sanitizeForKatex(String.raw`\raisebox{0.1em}[1em][0pt]{$x$}`, 'raised', 0);
    expect(raised).toBe(String.raw`\raisebox{0.1em}{$x$}`);
    expect(() => katex.renderToString(raised, { throwOnError: true })).not.toThrow();
  });

  it('colours SVG glyph macros without masking ordinary PDF or raster images', () => {
    const macros: MacroTable = {
      Pfi: { nargs: 0, def: String.raw`\includegraphics[height=.7em]{symbols/doublephi.svg}` },
      logo: { nargs: 0, def: String.raw`\includegraphics[height=.7em]{logo.png}` },
    };
    const html = renderStaticHtml(String.raw`{\color{red}\Pfi}\logo`, false, macros, { project: 'paper', docDir: '' });
    expect(html.match(/mask-image:/g)).toHaveLength(1);
    expect(html).toMatch(/class="enclosing lm-image-glyph" style="color:red;[^\"]*mask-image:/);
    expect(html).toContain('doublephi.svg?w=400');
    expect(html).toContain('src="/api/projects/paper/graphics/logo.png?w=400"');
  });

  it('renders overlay-based double-symbol macros such as \\Pfi, \\HH, \\XX and \\YY', () => {
    const overlap = String.raw`\sbox{\firstbox}{$\displaystyle #1$}\mathchoice{\ooalign{$#1$\cr\kern#3\wd\firstbox$#2$\cr}}{}{}{}`;
    const macros: MacroTable = {
      OverlapSymbols: { nargs: 3, def: overlap },
      doublephi: { nargs: 0, def: String.raw`\OverlapSymbols{\Phi}{\Phi}{0.3}` },
      doubleH: { nargs: 0, def: String.raw`\OverlapSymbols{\mathrm{H}}{\mathrm{H}}{0.5}` },
      doubleX: { nargs: 0, def: String.raw`\OverlapSymbols{\mathrm{X}}{\mathrm{X}}{0.5}` },
      doubleY: { nargs: 0, def: String.raw`\OverlapSymbols{\mathrm{Y}}{\mathrm{Y}}{0.5}` },
      Pfi: { nargs: 0, def: String.raw`\doublephi` },
      HH: { nargs: 0, def: String.raw`\doubleH` },
      XX: { nargs: 0, def: String.raw`\doubleX` },
      YY: { nargs: 0, def: String.raw`\doubleY` },
    };
    const km = katexMacros(macros);
    expect(km['\\doublephi']).toBe(String.raw`\mathord{\Phi\kern-0.5348em\Phi}`);
    for (const name of ['Pfi', 'HH', 'XX', 'YY']) {
      expect(() => katex.renderToString('\\' + name, { throwOnError: true, strict: false, trust: true, macros: km })).not.toThrow();
    }
  });

  it('#2 ignores browser ResizeObserver delivery notices but not real exceptions', () => {
    expect(isBenignBrowserError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isBenignBrowserError('ResizeObserver loop limit exceeded')).toBe(true);
    expect(isBenignBrowserError('ResizeObserver is not defined')).toBe(false);
  });
});
