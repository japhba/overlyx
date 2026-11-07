// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { parseTex, parseTexTitle, writeTex, writeTexPreserving } from '../packages/core/src/tex/index.ts';
import { lyxToPm, pmToLyxBody, walkInsets, setHeaderBlock, type LyxDocument, type Paragraph } from '../packages/core/src/index.ts';
import { renderTitlePreview } from '../packages/client/src/editor/nodeviews/title.ts';

const source = (preamble: string, body = '\\maketitle\n\nBody text.') => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
function preview(doc: LyxDocument): Paragraph[] {
  const inset = [...walkInsets(doc.body)].map(x => x.inset).find(x => x.type === 'Leaf' && x.name === 'Title');
  if (!inset || inset.type !== 'Leaf') return [];
  return parseTexTitle(doc.header.lines);
}

describe('preamble-based maketitle', () => {
  it('draws the title, formatted text, authors, date and math while keeping their definitions in the preamble', () => {
    const src = source('\\title[Short]{A \\textbf{study} of $x^2$}\n\\author{A. Writer \\and B. Writer}\n\\date{November 2026}');
    const parsed = parseTex(src);
    const pars = preview(parsed.doc);
    expect(pars.map(p => p.layout)).toEqual(['Title', 'Author', 'Date']);
    const dom = document.createElement('span');
    const math = vi.fn((el: HTMLElement) => { el.textContent = 'rendered formula'; });
    renderTitlePreview(dom, pars, math);
    expect(dom.querySelector('.lyx-layout-title')?.textContent).toBe('A study of rendered formula');
    expect(dom.querySelector('[data-series="bold"]')?.textContent).toBe('study');
    expect(dom.querySelector('.lyx-layout-author')?.textContent).toContain('A. Writer');
    expect(dom.querySelector('.lyx-layout-author br')).not.toBeNull();
    expect(dom.querySelector('.lyx-layout-date')?.textContent).toBe('November 2026');
    expect(math).toHaveBeenCalledWith(expect.anything(), 'x^2', false);
    const written = writeTex(parsed.doc).text;
    expect(written.match(/\\maketitle\b/g)).toHaveLength(1);
    expect(written.indexOf('\\title[Short]')).toBeLessThan(written.indexOf('\\begin{document}'));
    expect(preview(parseTex(written).doc)).toEqual(pars);
  });

  it('preserves untouched source and never duplicates the title after editing body text', () => {
    const src = source('\\title{A note}\n\\author{Your Name}\n\\date{}');
    const parsed = parseTex(src);
    const doc = { ...parsed.doc, body: pmToLyxBody(lyxToPm(parsed.doc)) };
    const save = () => writeTexPreserving(doc, { base: src, parse: t => parseTex(t), write: d => writeTex(d) }).text;
    expect(save()).toBe(src);
    const body = doc.body.find(p => p.items.some(i => i.kind === 'text' && i.text === 'Body text.'))!;
    body.items = [{ kind: 'text', text: 'Revised body.', font: {} }];
    const saved = save();
    expect(saved).toContain('Revised body.');
    expect(saved.match(/\\maketitle\b/g)).toHaveLength(1);
    expect(saved.match(/\\title\{/g)).toHaveLength(1);
    const dom = document.createElement('span');
    renderTitlePreview(dom, preview(parseTex(saved).doc), vi.fn());
    expect(dom.querySelector('.lyx-layout-date')?.textContent).toBe('');
  });

  it('uses the last direct declaration, ignores comments and macro bodies, and draws the default date', () => {
    const src = source('% \\title{Comment}\n\\author{Your Name}\n\\title{Old}\n\\newcommand{\\example}{\\title{Hidden}}\n\\AtBeginDocument{\\title{Hook}}\n\\title{Current}');
    const dom = document.createElement('span');
    renderTitlePreview(dom, preview(parseTex(src).doc), vi.fn());
    expect(dom.querySelector('.lyx-layout-title')?.textContent).toBe('Current');
    expect(dom.querySelector('.lyx-layout-date')?.textContent).toBe(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
    expect(dom.textContent).not.toContain('\\today');
    expect(dom.firstElementChild?.classList.contains('lyx-layout-title')).toBe(true);
  });

  it('refreshes from edited preamble metadata without storing a stale copy in the body', () => {
    const src = source('\\title{First}\n\\date{}');
    const doc = parseTex(src).doc;
    const before = JSON.stringify(doc.body);
    setHeaderBlock(doc.header, 'preamble', ['\\title{Second}', '\\date{}']);
    const dom = document.createElement('span');
    renderTitlePreview(dom, preview(doc), vi.fn());
    expect(dom.querySelector('.lyx-layout-title')?.textContent).toBe('Second');
    expect(JSON.stringify(doc.body)).toBe(before);
    const saved = writeTexPreserving(doc, { base: src, parse: t => parseTex(t), write: d => writeTex(d) }).text;
    expect(saved).toContain('\\title{Second}');
    expect(parseTex(saved).doc.body).toEqual(doc.body);
  });

  it('leaves missing metadata, custom maketitle definitions and body title paragraphs on their existing paths', () => {
    expect(preview(parseTex(source('')).doc)).toEqual([]);
    expect(preview(parseTex(source('\\title{A note}\n\\renewcommand{\\maketitle}{Custom title}')).doc)).toEqual([]);
    const doc = parseTex(source('', '\\title{Body title}\n\\author{Your Name}\n\\maketitle\n\nText.')).doc;
    expect(preview(doc)).toEqual([]);
    expect(doc.body[0].layout).toBe('Title');
    expect(writeTex(doc).text.match(/\\maketitle\b/g)).toHaveLength(1);
  });
});
