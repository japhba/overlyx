// @vitest-environment happy-dom
/**
 * Pasting several blocks (paragraphs, headings, a list, a table — from Word, Google Docs, a web
 * page) into a paragraph splits it: the blocks land as real paragraphs. ProseMirror fits pasted
 * content into the schema and used to wrap the paragraphs into the one inline node that can hold
 * blocks, the generic inset — whose default is a Note (`%% @note`, missing from the PDF).
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { pasteBlocksIntoEmpty } from '../packages/client/src/editor/plugins/paste.ts';

const WORD = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment--><p class=MsoNormal><b><span style='font-size:14.0pt'>Results</span></b></p><p class=MsoNormal>We observed a <i>significant</i> increase (p&lt;0.05) in firing rate, see Table&nbsp;1.<o:p></o:p></p><ul style='margin-top:0cm'><li class=MsoNormal>Session A: 3.2&nbsp;Hz</li><li class=MsoNormal>Session B: 2.8&nbsp;Hz</li></ul><table class=MsoTableGrid border=1><tr><td>Condition</td><td>Mean</td></tr><tr><td>Control</td><td>3.1</td></tr></table><!--EndFragment--></body></html>`;
const GDOCS = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c"><h2 dir="ltr"><span style="font-size:16pt;">Methods</span></h2><p dir="ltr"><span style="font-size:11pt;">The loss is </span><span style="font-style:italic;">L</span><span> and we use </span><a href="https://pytorch.org"><span>PyTorch</span></a><span> 2.1.</span></p><ol><li dir="ltr"><p dir="ltr"><span>Preprocess the data</span></p></li><li dir="ltr"><p dir="ltr"><span>Train for 10 steps</span></p></li></ol></b>`;
const MINIMAL = `<p>Results</p><p>Second paragraph</p><ul><li>One</li><li>Two</li></ul><table><tr><td>a</td><td>b</td></tr></table>`;

/** a view with the editor's paste handling of blocks into an empty paragraph (assembly.ts handlePaste) */
function editor(text: string, at: number): EditorView {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])]);
  let state = EditorState.create({ schema, doc });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + at)));
  const place = document.createElement('div');
  document.body.appendChild(place);
  return new EditorView(place, { state, handlePaste: (view, _event, slice) => pasteBlocksIntoEmpty(view, slice) });
}

const insets = (doc: PMNode) => { const out: string[] = []; doc.descendants(n => { if (n.type.name === 'inset') out.push(`${n.attrs.name} ${n.attrs.arg}`); }); return out; };
const tables = (doc: PMNode) => { let n = 0; doc.descendants(x => { if (x.type.name === 'table') n++; }); return n; };
const texts = (doc: PMNode) => { const out: string[] = []; doc.forEach(p => out.push(p.textContent)); return out; };

describe('pasting blocks into a paragraph', () => {
  for (const [name, html, words] of [['Word', WORD, ['Results', 'We observed', 'Session A', 'Session B']], ['Google Docs', GDOCS, ['Methods', 'The loss is', 'Preprocess', 'Train']], ['plain HTML', MINIMAL, ['Results', 'Second paragraph', 'One', 'Two']]] as const) {
    it(`${name}: real paragraphs, no Note around them, the paragraph split around them`, () => {
      const view = editor('Before after', 7);
      view.pasteHTML(html);
      const doc = view.state.doc;
      expect(insets(doc)).toEqual([]);
      const pars = texts(doc);
      expect(pars.length).toBeGreaterThanOrEqual(words.length);
      for (const w of words) expect(pars.some(t => t.startsWith(w) || t.includes(w)), w).toBe(true);
      // every pasted block is a paragraph of the document (not nested in anything)
      for (const w of words) { let top = false; doc.forEach(p => { if (p.textContent.includes(w)) top = true; }); expect(top, w).toBe(true); }
      expect(doc.textContent.startsWith('Before')).toBe(true);
      expect(doc.textContent.endsWith('after')).toBe(true);
      view.destroy();
    });
  }
  it('the table survives as a table', () => {
    const view = editor('Before after', 7);
    view.pasteHTML(MINIMAL);
    expect(tables(view.state.doc)).toBe(1);
    view.destroy();
  });
  it('lists become list paragraphs', () => {
    const view = editor('', 0);
    view.pasteHTML(MINIMAL);
    const layouts: string[] = [];
    view.state.doc.forEach(p => layouts.push(`${p.attrs.layout}:${p.textContent}`));
    expect(layouts).toContain('Itemize:One');
    expect(layouts).toContain('Itemize:Two');
    view.destroy();
  });
  it('a numbered list of paragraphs (Google Docs: <ol><li><p>) becomes Enumerate items, no empty bullets', () => {
    const view = editor('', 0);
    view.pasteHTML(GDOCS);
    const layouts: string[] = [];
    view.state.doc.forEach(p => layouts.push(`${p.attrs.layout}:${p.textContent}`));
    expect(layouts).toContain('Enumerate:Preprocess the data');
    expect(layouts).toContain('Enumerate:Train for 10 steps');
    expect(layouts.filter(l => /^(Itemize|Enumerate):$/.test(l))).toEqual([]);
    view.destroy();
  });
  it('blocks pasted into an empty paragraph replace it: a pasted heading stays a heading', () => {
    const view = editor('', 0);
    view.pasteHTML('<h2>Pasted title</h2><p>Some <b>bold</b> words</p>');
    const layouts: string[] = [];
    view.state.doc.forEach(p => layouts.push(`${p.attrs.layout}:${p.textContent}`));
    expect(layouts).toEqual(['Subsection:Pasted title', 'Standard:Some bold words']);
    expect(view.state.selection.$from.parent.textContent).toBe('Some bold words');
    view.destroy();
  });

  it('one pasted paragraph is inline text in the paragraph', () => {
    const view = editor('Before after', 7);
    view.pasteHTML('<p>middle <b>bold</b></p>');
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.textContent).toBe('Before middle boldafter');
    view.destroy();
  });
});
