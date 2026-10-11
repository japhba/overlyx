// @vitest-environment happy-dom
/**
 * Other people's carets in an HTML slide's text (deliverable runtime carets.ts): a caret travels as
 * places in the text box, which must mean the same where the box is retyped (formula and citation
 * chips) and where it is only shown (MathJax's <mjx-container>, <ol-cite>), and survive paragraphs,
 * list items, line breaks and the runtime's own elements. Colours from the awareness stay colours.
 */
import { describe, it, expect } from 'vitest';
import { offsetOf, pointAt, placesIn, safeColor } from '../packages/client/src/deliverable/runtime/carets.ts';

const box = (html: string): HTMLElement => {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.append(el);
  return el;
};

/** every place of the box mapped to a DOM point and back */
function roundTrip(el: Element): number[] {
  const out: number[] = [];
  for (let k = 0; k <= placesIn(el); k++) { const p = pointAt(el, k); out.push(offsetOf(el, p.node, p.offset)); }
  return out;
}

describe('places in a text box', () => {
  it('counts characters; a formula is one place, drawn as a chip or as MathJax output', () => {
    const editing = box('Euler: <span class="ol-mathchip ol-tex" contenteditable="false">\\(e^{i\\pi}\\)<mjx-container><svg></svg></mjx-container></span> is neat');
    const shown = box('Euler: <mjx-container class="MathJax"><svg><g></g></svg></mjx-container> is neat');
    expect(placesIn(editing)).toBe(7 + 1 + 8);
    expect(placesIn(shown)).toBe(placesIn(editing));
    // the caret right after the formula, in both
    const after = editing.childNodes[2] as Text;
    expect(offsetOf(editing, after, 0)).toBe(8);
    const p = pointAt(shown, 8);
    expect(p.node).toBe(shown.childNodes[2]);
    expect(p.offset).toBe(0);
    // before it
    expect(offsetOf(editing, editing, 1)).toBe(7);
    expect(offsetOf(shown, shown.childNodes[0], 7)).toBe(7);
    // (a point inside the chip is before it)
    expect(offsetOf(editing, editing.querySelector('svg')!, 0)).toBe(7);
  });

  it('a citation is one place, chip or <ol-cite>', () => {
    const editing = box('see <span class="ol-refchip ol-citechip" contenteditable="false" data-ol-cite="\\cite{a}">[1]</span>.');
    const shown = box('see <ol-cite data-ol-cite="\\cite{a}">[1]</ol-cite>.');
    expect(placesIn(editing)).toBe(6);
    expect(placesIn(shown)).toBe(6);
    expect(offsetOf(editing, editing.lastChild!, 1)).toBe(6);
    expect(pointAt(shown, 6)).toEqual({ node: shown.lastChild, offset: 1 });
  });

  it('a paragraph or list item adds a place where it starts: the end of one item is not the start of the next', () => {
    const el = box('<ul><li>one</li><li>two</li></ul>');
    // ul, li, "one", li, "two"
    expect(placesIn(el)).toBe(1 + 1 + 3 + 1 + 3);
    const [one, two] = Array.from(el.querySelectorAll('li')).map(li => li.firstChild as Text);
    expect(offsetOf(el, one, 3)).toBe(5);
    expect(offsetOf(el, two, 0)).toBe(6);
    expect(pointAt(el, 5)).toEqual({ node: one, offset: 3 });
    expect(pointAt(el, 6)).toEqual({ node: two, offset: 0 });
    expect(roundTrip(el)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('an empty paragraph is a place of its own', () => {
    const el = box('<p>a</p><p><br></p><p>b</p>');
    const empty = el.children[1];
    // p "a" p br p "b"
    expect(placesIn(el)).toBe(6);
    expect(pointAt(el, 3)).toEqual({ node: empty, offset: 0 });
    expect(offsetOf(el, empty, 0)).toBe(3);
    expect(offsetOf(el, empty, 1)).toBe(4);
  });

  it('line breaks and pictures are places; the runtime\'s own elements and scripts are none', () => {
    const el = box('a<br>b<img src="x.png">c<span data-ol-runtime="">ghost</span><script>x()</script>d');
    expect(placesIn(el)).toBe(6);
    expect(offsetOf(el, el.lastChild!, 1)).toBe(6);
    expect(roundTrip(el)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('styled runs: the same places whether the text is one node or split by inline elements', () => {
    const a = box('Hello <b>bold</b> world');
    const b = box('Hello bold world');
    expect(placesIn(a)).toBe(placesIn(b));
    expect(offsetOf(a, a.querySelector('b')!.firstChild!, 2)).toBe(8);
    expect(pointAt(b, 8)).toEqual({ node: b.firstChild, offset: 8 });
    expect(roundTrip(a)).toEqual(Array.from({ length: placesIn(a) + 1 }, (_, i) => i));
  });

  it('places past the end are the end; a point outside the box is its start', () => {
    const el = box('abc');
    const end = pointAt(el, 99);
    expect(offsetOf(el, end.node, end.offset)).toBe(3);
    expect(pointAt(el, -4)).toEqual({ node: el.firstChild, offset: 0 });
    expect(offsetOf(el, document.body, 0)).toBe(0);
  });
});

describe('colours from the awareness', () => {
  it('only colours pass', () => {
    expect(safeColor('#30bced')).toBe('#30bced');
    expect(safeColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
    expect(safeColor('hsla(10, 50%, 40%, .5)')).toBe('hsla(10, 50%, 40%, .5)');
    expect(safeColor('red;background:url(//x)')).toBe('#888');
    expect(safeColor('"><img src=x>')).toBe('#888');
    expect(safeColor(null)).toBe('#888');
  });
});
