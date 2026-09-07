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
    expect(sanitized).toBe(def);
    const macros: MacroTable = { Pfi: { nargs: 0, def: sanitized }, tPfi: { nargs: 0, def: String.raw`\tilde{\Pfi}` } };
    const html = renderStaticHtml('$\\Pfi_{ij},\\quad\\tPfi_{ij}$', false, macros, { project: 'paper', docDir: 'chapters' });
    expect(html).toContain('<img');
    expect(html).toMatch(/src="\/api\/projects\/paper\/graphics\/chapters(?:\/|%2F)glyph\.pdf\?w=400"/);
    expect(html).not.toContain('>Pfi<');
  });

  it('#4 approximates the font-height/raisebox/includesvg form used by the reported macro', () => {
    const source = String.raw`\NewDocumentCommand{\myPfi}{}{\text{\normalfont \bbheight=\fontcharht\font\`0 \raisebox{-0.04\bbheight}[\bbheight][0pt]{\includesvg[height=1.08\bbheight]{doublephi.svg}}}}`;
    const defs = macrosFromLatex(source).macros;
    const transported = toMathliveMacros(defs);
    expect(transported.myPfi.def).toContain(String.raw`\includegraphics[height=1.08em]{doublephi.svg}`);
    expect(transported.myPfi.def).not.toMatch(/fontcharht|raisebox|includesvg/);
    const macros: MacroTable = { myPfi: { nargs: 0, def: transported.myPfi.def } };
    expect(() => katex.renderToString(String.raw`\myPfi`, { throwOnError: true, strict: false, trust: true, macros: katexMacros(macros) })).not.toThrow();
  });

  it('#2 ignores browser ResizeObserver delivery notices but not real exceptions', () => {
    expect(isBenignBrowserError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isBenignBrowserError('ResizeObserver loop limit exceeded')).toBe(true);
    expect(isBenignBrowserError('ResizeObserver is not defined')).toBe(false);
  });
});
