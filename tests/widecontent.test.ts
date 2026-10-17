// @vitest-environment happy-dom
/**
 * The width display formulas and tables may take (client editor/widecontent.ts, the ruler's second
 * track): the full pane by default, the text column at least, a width set in between; kept per user,
 * and whoever listens hears of a change.
 */
import { describe, it, expect } from 'vitest';
import { wideWidth, setWideWidth, onWideWidth, wideRoom, paneRoom, WIDE_FULL, WIDE_TEXT } from '../packages/client/src/editor/widecontent';

/** a document pane `pane` px wide (with a notes pane of `notes` px) and an element in it */
function inPane(pane: number, notes = 0): HTMLElement {
  const scroll = document.createElement('div');
  scroll.className = 'editor-scroll';
  Object.defineProperty(scroll, 'clientWidth', { value: pane });
  if (notes) scroll.style.setProperty('--notes-col', notes + 'px');
  const el = document.createElement('div');
  scroll.append(el);
  document.body.append(scroll);
  return el;
}

describe('the room for wide content', () => {
  it('is the pane by default, the column at least, a set width in between', () => {
    const el = inPane(1200);
    setWideWidth(WIDE_FULL);
    expect(paneRoom(el)).toBe(1168);
    expect(wideRoom(el, 720)).toBe(1168);
    setWideWidth(WIDE_TEXT);
    expect(wideRoom(el, 720)).toBe(720);
    setWideWidth(900);
    expect(wideRoom(el, 720)).toBe(900);
    // never narrower than the column, never wider than the pane
    expect(wideRoom(el, 1000)).toBe(1000);
    setWideWidth(5000);
    expect(wideRoom(el, 720)).toBe(1168);
    // the notes pane is not room for formulas
    expect(wideRoom(inPane(1200, 340), 600)).toBe(828);
    setWideWidth(WIDE_FULL);
  });

  it('is kept per user and announced', () => {
    let heard = 0;
    const off = onWideWidth(() => { heard++; });
    setWideWidth(950.4);
    expect(wideWidth()).toBe(950);
    expect(localStorage.getItem('ol.wideWidth')).toBe('950');
    setWideWidth(950);
    expect(heard).toBe(1);   // (the same width again: nothing changed)
    off();
    setWideWidth(WIDE_FULL);
    expect(heard).toBe(1);
  });
});
