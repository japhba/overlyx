// @vitest-environment happy-dom
/**
 * Accept / reject in the text (editor/plugins/changeactions.ts): the bar over a tracked change
 * shows its author and date, and one click settles the change together with the runs touching it
 * by the same author (`changeGroupAt`) — a replacement or a suggestion across a paragraph break is
 * one decision. Not on a read-only editor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { changeGroupAt, resolveChanges } from '../packages/client/src/editor/plugins/changes.ts';
import { changeActionsPlugin, shortChangeDate } from '../packages/client/src/editor/plugins/changeactions.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';

const T = 1759658400;   // 5 Oct 2025, 10:00 UTC
const change = (type: 'inserted' | 'deleted', author = 3) => schema.marks.change.create({ type, author, time: T });
const endChange = (type: 'inserted' | 'deleted', author = 3) => JSON.stringify({ type, author, time: T });
const par = (content: PMNode[], end?: string) => schema.nodes.paragraph.create({ layout: 'Standard', endChange: end ?? null }, content);
const docOf = (...ps: PMNode[]) => schema.nodes.doc.create(null, ps);
const text = (s: string, ...marks: ReturnType<typeof change>[]) => schema.text(s, marks);
const plain = (doc: PMNode) => { const out: string[] = []; doc.forEach(p => out.push(p.textContent)); return out; };

/** Hello [old→new] world, by author 3; "!" inserted by author 4 right after */
const replacement = () => docOf(par([text('Hello '), text('old', change('deleted')), text('new', change('inserted')), text('!', change('inserted', 4)), text(' world')]));

function settle(doc: PMNode, pos: number, accept: boolean, boundary = false): PMNode {
  let state = EditorState.create({ doc });
  const group = changeGroupAt(state.doc, pos, boundary)!;
  resolveChanges(group, accept)(state, tr => { state = state.apply(tr); });
  return state.doc;
}

describe('changeGroupAt: what one ✓ / ✗ settles', () => {
  it('a deletion and the insertion right after it by the same author are one replacement; another author\'s touching run is not', () => {
    const doc = replacement();
    const group = changeGroupAt(doc, 8)!;   // inside "old"
    expect(group.map(r => [doc.textBetween(r.from, r.to), r.type])).toEqual([['old', 'deleted'], ['new', 'inserted']]);
    expect(changeGroupAt(doc, 11)).toEqual(group);   // inside "new": the same group
    expect(changeGroupAt(doc, 13)!.map(r => doc.textBetween(r.from, r.to))).toEqual(['!']);
    expect(changeGroupAt(doc, 2)).toBeNull();
  });

  it('accepting the replacement keeps the new text, rejecting it keeps the old, the other author\'s change stays', () => {
    expect(plain(settle(replacement(), 8, true))).toEqual(['Hello new! world']);
    expect(plain(settle(replacement(), 8, false))).toEqual(['Hello old! world']);
    const kept = settle(replacement(), 8, true);
    expect(changeGroupAt(kept, 10)!.map(r => [kept.textBetween(r.from, r.to), r.author])).toEqual([['!', 4]]);
  });

  it('a deletion across a paragraph break is one suggestion: accepting it joins the paragraphs', () => {
    const doc = docOf(par([text('Keep '), text('gone', change('deleted'))], endChange('deleted')), par([text('also gone', change('deleted')), text(' rest')]));
    const group = changeGroupAt(doc, 7)!;
    expect(group.map(r => r.boundary ?? false)).toEqual([false, true, false]);
    expect(changeGroupAt(doc, group[1].from, true)).toEqual(group);   // from the ¶ marker
    expect(plain(settle(doc, 7, true))).toEqual(['Keep  rest']);
    expect(plain(settle(doc, 7, false))).toEqual(['Keep gone', 'also gone rest']);
  });

  it('unchanged text between two changes separates them', () => {
    const doc = docOf(par([text('a', change('inserted')), text(' b '), text('c', change('inserted'))]));
    expect(changeGroupAt(doc, 1)!.length).toBe(1);
    expect(plain(settle(doc, 1, false))).toEqual([' b c']);
  });
});

describe('the bar over a change', () => {
  let view: EditorView;
  let editable = true;
  beforeEach(() => {
    (editorContext as any).meta = { authors: [{ id: 3, name: 'Ada Lovelace' }, { id: 4, name: 'Bob' }] };
    editable = true;
    const place = document.createElement('div');
    document.body.appendChild(place);
    view = new EditorView(place, { state: EditorState.create({ doc: replacement(), plugins: [changeActionsPlugin()] }), editable: () => editable });
  });
  afterEach(() => { view.destroy(); document.body.innerHTML = ''; (editorContext as any).meta = null; });

  const hover = (el: Element) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 5, clientY: 5 }));

  it('shows the author and the date of the change under the pointer; ✓ accepts the whole replacement', () => {
    hover(view.dom.querySelector('.lyx-change-deleted')!);
    const bar = document.querySelector('.change-actions')!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.change-actions-author')!.textContent).toBe('Ada Lovelace');
    expect(bar.querySelector('.change-actions-date')!.textContent).toBe(shortChangeDate(T));
    expect(bar.querySelector('.change-actions-info')!.getAttribute('title')).toMatch(/^Changed by Ada Lovelace on /);
    expect(bar.querySelector('.change-action.accept')!.getAttribute('title')).toBe('Accept this change');
    (bar.querySelector('.change-action.accept') as HTMLElement).click();
    expect(plain(view.state.doc)).toEqual(['Hello new! world']);
    expect(document.querySelector('.change-actions')).toBeNull();
  });

  it('✗ on another author\'s insertion rejects only that', () => {
    const bang = Array.from(view.dom.querySelectorAll('.lyx-change-inserted')).find(e => e.textContent === '!')!;
    hover(bang);
    const bar = document.querySelector('.change-actions')!;
    expect(bar.querySelector('.change-actions-author')!.textContent).toBe('Bob');
    expect(bar.querySelector('.change-action.reject')!.getAttribute('title')).toBe('Reject this insertion');
    (bar.querySelector('.change-action.reject') as HTMLElement).click();
    expect(plain(view.state.doc)).toEqual(['Hello oldnew world']);
  });

  it('not on a read-only document', () => {
    editable = false;
    view.setProps({});
    hover(view.dom.querySelector('.lyx-change-deleted')!);
    expect(document.querySelector('.change-actions')).toBeNull();
  });
});

describe('shortChangeDate', () => {
  it('the time today, day and month this year, the year before', () => {
    const now = new Date(2026, 9, 5, 18, 0);
    expect(shortChangeDate(new Date(2026, 9, 5, 9, 30).getTime() / 1000, now)).not.toMatch(/Oct|2026/);
    expect(shortChangeDate(new Date(2026, 8, 3, 9, 30).getTime() / 1000, now)).toMatch(/Sep/);
    expect(shortChangeDate(new Date(2025, 8, 3, 9, 30).getTime() / 1000, now)).toMatch(/2025/);
    expect(shortChangeDate(0)).toBe('');
  });
});
