// @vitest-environment happy-dom
/**
 * Alt+- types an em dash (it used to insert an invisible hyphenation point, so the key looked dead —
 * the usage statistics showed it pressed again and again). On a Mac ⌥- arrives as the en-dash
 * character with the minus key's code; ProseMirror falls back to the key code, so the binding must
 * give a visible dash there too. Alt+Shift+- is the en dash, except on a Mac, where ⌥⇧- stays the
 * system's own em dash.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '@overlyx/core';
import { lyxKeymap } from '../packages/client/src/editor/keymap';

const realPlatform = navigator.platform;
const setPlatform = (p: string) => Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
afterEach(() => setPlatform(realPlatform));

function editor(): EditorView {
  const doc = schema.node('doc', null, [schema.node('paragraph', { layout: 'Standard' }, [schema.text('a b')])]);
  let state = EditorState.create({ doc, plugins: [lyxKeymap()] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));   // after "a"
  return new EditorView(document.createElement('div'), { state });
}
function press(view: EditorView, init: { key: string; keyCode: number; altKey?: boolean; shiftKey?: boolean }): boolean {
  const ev = new KeyboardEvent('keydown', { key: init.key, altKey: !!init.altKey, shiftKey: !!init.shiftKey, bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
  return !!view.someProp('handleKeyDown', f => f(view, ev));
}
const MINUS = 189;

describe('dash keys', () => {
  it('Alt+- types an em dash (Windows / Linux: the key is "-")', () => {
    setPlatform('Linux x86_64');
    const v = editor();
    expect(press(v, { key: '-', keyCode: MINUS, altKey: true })).toBe(true);
    expect(v.state.doc.textContent).toBe('a— b');
    v.destroy();
  });
  it('Alt+Shift+- types an en dash on Windows / Linux', () => {
    setPlatform('Win32');
    const v = editor();
    expect(press(v, { key: '_', keyCode: MINUS, altKey: true, shiftKey: true })).toBe(true);
    expect(v.state.doc.textContent).toBe('a– b');
    v.destroy();
  });
  it('⌥- on a Mac (the key reports "–") gives the em dash, not an invisible hyphenation point', () => {
    setPlatform('MacIntel');
    const v = editor();
    expect(press(v, { key: '–', keyCode: MINUS, altKey: true })).toBe(true);
    expect(v.state.doc.textContent).toBe('a— b');
    let special = 0;
    v.state.doc.descendants(n => { if (n.type.name === 'special') special++; });
    expect(special).toBe(0);
    v.destroy();
  });
  it('⌥⇧- on a Mac is left to macOS (its em dash is typed as text)', () => {
    setPlatform('MacIntel');
    const v = editor();
    expect(press(v, { key: '—', keyCode: MINUS, altKey: true, shiftKey: true })).toBe(false);
    expect(v.state.doc.textContent).toBe('a b');
    v.destroy();
  });
});
