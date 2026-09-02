// @vitest-environment happy-dom
/**
 * Copying from the Agent panel's transcript (app/richcopy.ts, wired to the copy event in
 * AgentPanel.tsx): the KaTeX-rendered formulas leave the selection as their LaTeX source —
 * `$…$` inline, `\[…\]` display — while everything else keeps its visible text, so an equation
 * drag-selected in the agent's reply pastes into the editor (or a formula, or a .tex file) as
 * real LaTeX. And a paste INTO a formula sheds the delimiters it arrived with.
 */
import { describe, it, expect } from 'vitest';
import { latexSelectionText } from '../packages/client/src/app/richcopy.ts';
import { stripMathDelims } from '../packages/client/src/editor/lyxmath/field.ts';

const setup = (html: string) => { document.body.innerHTML = html; return document.body; };
const mkSel = (...ranges: Range[]) =>
  ({ rangeCount: ranges.length, isCollapsed: false, getRangeAt: (i: number) => ranges[i] }) as unknown as Selection;
const over = (el: Node) => { const r = document.createRange(); r.selectNodeContents(el); return r; };

const INLINE = '<div class="agent-msg">energy <span class="agent-math" data-latex="E=mc^{2}"><span class="katex">𝐸=𝑚𝑐²</span></span> matters</div>';

describe('latexSelectionText', () => {
  it('a message with an inline formula copies as $…$', () => {
    expect(latexSelectionText(mkSel(over(setup(INLINE))))).toBe('energy $E=mc^{2}$ matters');
  });
  it('display math copies with \\[ … \\] on their own lines', () => {
    const root = setup('<div class="agent-msg">so<div class="agent-math-block"><span class="agent-math display" data-latex="\\int f\\,dx" data-display="1"><span class="katex">∫f dx</span></span></div>holds</div>');
    expect(latexSelectionText(mkSel(over(root)))).toBe('so\n\\[\n\\int f\\,dx\n\\]\nholds');
  });
  it('a drag inside one formula’s own KaTeX DOM takes the formula whole', () => {
    const glyphs = setup(INLINE).querySelector('.katex')!.firstChild as Text;
    const r = document.createRange(); r.setStart(glyphs, 1); r.setEnd(glyphs, 3);
    expect(latexSelectionText(mkSel(r))).toBe('$E=mc^{2}$');
  });
  it('a selection without any formula is left to the browser', () => {
    expect(latexSelectionText(mkSel(over(setup('<div class="agent-msg">just words</div>'))))).toBeNull();
    expect(latexSelectionText(null)).toBeNull();
  });
});

describe('stripMathDelims', () => {
  it('sheds matching delimiters', () => {
    expect(stripMathDelims('$E=mc^2$')).toBe('E=mc^2');
    expect(stripMathDelims('$$E$$')).toBe('E');
    expect(stripMathDelims('\\[\nE\n\\]')).toBe('E');
    expect(stripMathDelims('\\(E\\)')).toBe('E');
  });
  it('leaves unbalanced or absent delimiters alone', () => {
    expect(stripMathDelims('E=mc^2')).toBe('E=mc^2');
    expect(stripMathDelims('$$E$')).toBe('$$E$');
    expect(stripMathDelims('\\[E\\)')).toBe('\\[E\\)');
  });
});
