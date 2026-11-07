// @vitest-environment jsdom
/**
 * Arrows typed in a slide's text (packages/client/src/deliverable/runtime/arrows.ts, the rule table of
 * core/arrows.ts shared with documents): the typed characters become the arrow in the text being
 * retyped, Backspace right after gives them back (and they then stay), code is left alone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { arrowInput, arrowBackspace } from '../packages/client/src/deliverable/runtime/arrows';
import { ARROW_RULES } from '../packages/client/src/editor/plugins/arrows';
import { ARROW_RULES as CORE_RULES } from '../packages/core/src/arrows';

/** a text being retyped on a slide, and keys typed into it as contenteditable does (the character in, then the input event) */
function box(html = '<p></p>') {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.innerHTML = html;
  document.body.replaceChildren(root);
  const p = root.querySelector('p, code') as HTMLElement;
  const node = document.createTextNode('');
  p.append(node);
  getSelection()!.collapse(node, 0);
  const type = (s: string) => {
    for (const ch of s) {
      const sel = getSelection()!;
      const t = sel.anchorNode as Text, at = sel.anchorOffset;
      t.insertData(at, ch);
      sel.collapse(t, at + 1);
      arrowInput({ inputType: 'insertText', data: ch, isComposing: false } as InputEvent, root);
    }
  };
  const backspace = () => {
    if (arrowBackspace(root)) return;
    const sel = getSelection()!;
    const t = sel.anchorNode as Text, at = sel.anchorOffset;
    t.deleteData(at - 1, 1);
    sel.collapse(t, at - 1);
  };
  return { root, type, backspace, text: () => root.textContent };
}

beforeEach(() => { document.body.replaceChildren(); });

describe('arrows on slides', () => {
  it('the documents\' rules, from core', () => {
    expect(ARROW_RULES).toBe(CORE_RULES);
  });

  it('-> <- --> <-- <-> <--> become arrows as they are typed', () => {
    for (const [keys, want] of [['a -> b', 'a → b'], ['a <- b', 'a ← b'], ['a --> b', 'a ⟶ b'], ['a <-- b', 'a ⟵ b'], ['a <-> b', 'a ↔ b'], ['a <--> b', 'a ⟷ b']]) {
      const b = box();
      b.type(keys);
      expect(b.text()).toBe(want);
    }
  });

  it('Backspace right after gives the typed keys back, and they stay as typed', () => {
    const b = box();
    b.type('a <-');
    expect(b.text()).toBe('a ←');
    b.backspace();
    expect(b.text()).toBe('a <-');
    // the characters put back stay: another - does not make ⟵
    b.type('-');
    expect(b.text()).toBe('a <--');
    // ← then - is ⟵: Backspace gives back all three keys
    const c = box();
    c.type('x <--');
    expect(c.text()).toBe('x ⟵');
    c.backspace();
    expect(c.text()).toBe('x <--');
  });

  it('Backspace later, or elsewhere, deletes as usual', () => {
    const b = box();
    b.type('a -> b');
    b.backspace();
    expect(b.text()).toBe('a → ');
    b.backspace(); b.backspace();
    expect(b.text()).toBe('a ');
  });

  it('a dash the keyboard made of -- (smart punctuation) and > is the long arrow', () => {
    const b = box();
    b.type('a —>');
    expect(b.text()).toBe('a ⟶');
  });

  it('code is left as typed', () => {
    const b = box('<code></code>');
    b.type('x -> y');
    expect(b.text()).toBe('x -> y');
  });
});
