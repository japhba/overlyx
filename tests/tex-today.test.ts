// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMParser, DOMSerializer } from 'prosemirror-model';
import { lyxToPm, pmToLyxBody, schema, walkInsets } from '../packages/core/src/index.ts';
import { parseTex, writeTex, writeTexPreserving } from '../packages/core/src/tex/index.ts';
import { LeafView } from '../packages/client/src/editor/nodeviews/leaf.ts';

const source = (body: string, preamble = '') => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const currentDate = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

afterEach(() => vi.useRealTimers());

describe('\\today in text', () => {
  it('draws dates in body text, formatted text and nested insets, preserving the command through saving and copying', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2030, 0, 2, 12));
    const src = source('Updated \\today{}, \\textbf{\\today}. \\footnote{As of \\today.}');
    const parsed = parseTex(src);
    const insets = [...walkInsets(parsed.doc.body)].map(x => x.inset);
    expect(insets.filter(i => i.type === 'Leaf' && i.name === 'Date')).toHaveLength(3);
    expect(insets.some(i => i.type === 'Text' && i.name === 'ERT')).toBe(false);
    const pm = schema.nodeFromJSON(lyxToPm(parsed.doc));
    const dom = document.createElement('div');
    dom.append(DOMSerializer.fromSchema(schema).serializeFragment(pm.content));
    expect([...dom.querySelectorAll('.lyx-leaf-date')].map(el => el.textContent)).toEqual(Array(3).fill(currentDate()));
    expect(JSON.parse(dom.querySelectorAll('.lyx-leaf-date')[1].getAttribute('data-marks')!)).toContainEqual({ type: 'series', attrs: { value: 'bold' } });
    const copied = DOMParser.fromSchema(schema).parse(dom);
    const saved = writeTex({ ...parsed.doc, body: pmToLyxBody(copied.toJSON()) }).text;
    expect(saved.match(/\\today\b/g)).toHaveLength(3);
    expect(saved).not.toContain(currentDate());
    expect(writeTex(parseTex(saved).doc).text).toBe(saved);
    expect(writeTexPreserving(parsed.doc, { base: src, parse: t => parseTex(t), write: d => writeTex(d) }).text).toBe(src);
  });

  it('renders the current date in the editor without storing a date in the model', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2030, 0, 2, 12));
    const doc = parseTex(source('\\today')).doc;
    const before = JSON.stringify(doc.body);
    const pm = schema.nodeFromJSON(lyxToPm(doc));
    const node = pm.firstChild!.firstChild!;
    const view = new LeafView(node, {} as never, () => 1);
    expect(view.dom.textContent).toBe(currentDate());
    expect(view.dom.classList.contains('lyx-button')).toBe(false);
    vi.setSystemTime(new Date(2030, 0, 3, 12));
    expect(view.update(node)).toBe(true);
    expect(view.dom.textContent).toBe(currentDate());
    expect(JSON.stringify(doc.body)).toBe(before);
    expect(writeTex(doc).text).toContain('\\today');
    view.destroy();
  });

  it('keeps custom definitions and longer command names as raw LaTeX', () => {
    for (const src of [source('\\today', '\\renewcommand{\\today}{A fixed date}'), source('\\todayish')]) {
      const doc = parseTex(src).doc;
      const insets = [...walkInsets(doc.body)].map(x => x.inset);
      expect(insets.some(i => i.type === 'Leaf' && i.name === 'Date')).toBe(false);
      expect(insets.some(i => i.type === 'Text' && i.name === 'ERT')).toBe(true);
      expect(writeTex(doc).text).toContain(src.includes('todayish') ? '\\todayish' : '\\today');
    }
  });
});
