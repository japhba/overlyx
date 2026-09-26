// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { macrosFromLatex, sanitizeForMathlive, toMathliveMacros } from '../packages/core/src/macros.ts';
import { mathjaxMacros, sanitizeForMathjax } from '../packages/core/src/math/mathjax.ts';
import { isBenignBrowserError } from '../packages/client/src/error-reporting.ts';
import { renderStaticHtml } from '../packages/client/src/editor/lyxmath/field.ts';
import { mathReady } from '../packages/client/src/editor/lyxmath/mathjax.ts';
import type { MacroTable } from '../packages/core/src/math/ast.ts';
import { toMathml } from './mathjax.ts';

/** the heights (em of the formula) of the image glyphs in a formula's MathML: mglyph heights are TeX's text em as px (16px = 1em) */
const glyphHeights = (mml: string) => [...mml.matchAll(/<mglyph[^>]*height="([\d.]+)px"/g)].map(m => Math.round(Number(m[1]) / 16 * 1000) / 1000);

describe('GitHub bug reports', () => {
  beforeAll(() => mathReady());
  it('#4 renders a minimal image-based macro instead of its literal name', () => {
    const def = String.raw`\mathord{\includegraphics[height=0.7em]{glyph.pdf}}`;
    const sanitized = sanitizeForMathjax(def, 'Pfi', 0);
    expect(sanitized).toContain('lm-image-glyph');
    expect(sanitizeForMathjax(sanitized, 'Pfi', 0)).toBe(sanitized);
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
    expect(() => toMathml(String.raw`\myPfi`, mathjaxMacros(macros))).not.toThrow();
    expect(sanitizeForMathjax(transported.myPfi.def, 'myPfi', 0)).toBe(transported.myPfi.def);
    expect(sanitizeForMathjax(defs[0].def, 'myPfi', 0)).toBe(transported.myPfi.def);
    // the image is as tall as TeX's em says, also in scripts (its own \mathchoice scales it there)
    expect(glyphHeights(toMathml(String.raw`\myPfi`, mathjaxMacros(macros)))).toEqual([0.696]);
    for (const formula of [String.raw`\myPfi`, String.raw`x_{\myPfi}`, String.raw`x^{\myPfi}`, String.raw`x_{x_{\myPfi}}`]) {
      const html = renderStaticHtml(formula, false, macros, { project: 'paper', docDir: 'chapters' });
      expect(html).toMatch(/<img[^>]*style="[^"]*height: [\d.]+em/);
      expect(decodeURIComponent(html)).toMatch(/mask-image: ?url\(&quot;\/api\/projects\/paper\/graphics\/chapters\/doublephi\.svg\?w=400&quot;\)/);
      expect(html).not.toMatch(/lm-error|lm-undefined/);
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
    // \mathchoice picks the size for the style: text size, then script and scriptscript
    const mm = mathjaxMacros(macros);
    expect(glyphHeights(toMathml(String.raw`\Pfi`, mm))).toEqual([0.683]);
    expect(glyphHeights(toMathml(String.raw`x_{\Pfi}`, mm))).toEqual([0.478]);
    expect(glyphHeights(toMathml(String.raw`x_{x_{\Pfi}}`, mm))).toEqual([0.342]);
    for (const formula of [String.raw`\Pfi`, String.raw`\tPfi`, String.raw`x_{\Pfi}`, String.raw`x_{x_{\Pfi}}`]) {
      const html = renderStaticHtml(formula, false, macros, { project: 'paper', docDir: '' });
      expect(html).toMatch(/<img[^>]*style="[^"]*height: [\d.]+em/);
      expect(html).toContain('mask-image:');
      expect(html).not.toMatch(/lm-error|lm-unknown|lm-undefined|>doublephi</);
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
    expect(sanitizeForMathjax(transported.doublephi.def, 'doublephi', 0)).toBe(transported.doublephi.def);
    const bare = toMathml(String.raw`\Pfi`, mathjaxMacros(macros));
    expect(bare).toMatch(/<mpadded[^>]*voffset="-0\.02756em"/);
    expect(glyphHeights(bare)).toEqual([0.744]);
    for (const formula of [String.raw`\Pfi`, String.raw`\tPfi`, String.raw`x_{\Pfi}`, String.raw`x^{\Pfi}`, String.raw`x_{x_{\Pfi}}`]) {
      const html = renderStaticHtml(formula, false, macros, { project: 'paper', docDir: '' });
      expect(html).toContain('mask-image:');
      expect(html).not.toMatch(/lm-error|lm-unknown|lm-undefined|>doublephi</);
    }
    const raised = sanitizeForMathjax(String.raw`\raisebox{0.1em}[1em][0pt]{$x$}`, 'raised', 0);
    expect(raised).toBe(String.raw`\raisebox{0.1em}{$x$}`);
    expect(() => toMathml(raised)).not.toThrow();
  });

  it('colours SVG glyph macros without masking ordinary PDF or raster images', () => {
    const macros: MacroTable = {
      Pfi: { nargs: 0, def: String.raw`\includegraphics[height=.7em]{symbols/doublephi.svg}` },
      logo: { nargs: 0, def: String.raw`\includegraphics[height=.7em]{logo.png}` },
    };
    const html = renderStaticHtml(String.raw`{\color{red}\Pfi}\logo`, false, macros, { project: 'paper', docDir: '' });
    expect(html.match(/mask-image:/g)).toHaveLength(1);
    // the red of \color reaches the masked glyph (it is drawn in currentColor)
    expect(html).toMatch(/style="color: red;?"[^]*class="lm-image-glyph"[^]*<mjx-mglyph[^>]*mask-image: ?url\(&quot;[^&]*doublephi\.svg\?w=400/);
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
    const km = mathjaxMacros(macros);
    expect(km['\\doublephi']).toBe(String.raw`\mathord{\Phi\kern-0.5348em\Phi}`);
    for (const name of ['Pfi', 'HH', 'XX', 'YY']) expect(() => toMathml('\\' + name, km)).not.toThrow();
  });

  it('#2 ignores browser ResizeObserver delivery notices but not real exceptions', () => {
    expect(isBenignBrowserError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isBenignBrowserError('ResizeObserver loop limit exceeded')).toBe(true);
    expect(isBenignBrowserError('ResizeObserver is not defined')).toBe(false);
  });
});
