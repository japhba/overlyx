// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { setInlineStep } from '../packages/client/src/deliverable/runtime/inlinesteps.ts';
import { expandPrintSteps, showSlideStep, slideStepCount, STEP_VISIBILITY_CSS } from '../packages/client/src/deliverable/runtime/steps.ts';

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.classList.remove('ol-steps-dim');
  getSelection()?.removeAllRanges();
});

function slide(html: string): HTMLElement {
  const el = document.createElement('section');
  el.className = 'slide';
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

function select(start: Node, from: number, end: Node, to: number): Selection {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  const selection = getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function visibilityCss() {
  const css = document.createElement('style');
  css.textContent = STEP_VISIBILITY_CSS;
  document.head.append(css);
}

describe('inline click steps', () => {
  it('presents inline spans, strong, em and u on their specified steps without removing content', () => {
    visibilityCss();
    const s = slide('<p>First <span data-step="2">second</span> <strong data-step="3">third</strong> <em data-step="2-3">brief</em> <u data-step="-2">early</u></p>');
    const inline = Array.from(s.querySelectorAll('[data-step]'));
    expect(slideStepCount(s)).toBe(4);
    showSlideStep(s, 1);
    expect(inline.map(e => getComputedStyle(e).visibility)).toEqual(['hidden', 'hidden', 'hidden', 'visible']);
    showSlideStep(s, 2);
    expect(inline.map(e => e.hasAttribute('data-ol-unshown'))).toEqual([false, true, false, false]);
    showSlideStep(s, 4);
    expect(inline.map(e => e.hasAttribute('data-ol-unshown'))).toEqual([false, false, true, true]);
    showSlideStep(s, 1); // navigating backwards restores earlier visibility
    expect(inline.map(e => e.hasAttribute('data-ol-unshown'))).toEqual([true, true, true, false]);
    expect(s.textContent).toBe('First second third brief early');
  });

  it('marks only the selected words and preserves their formatting and surrounding text', () => {
    const s = slide('<p>Earlier <strong>new result</strong> later.</p>');
    const root = s.firstElementChild as HTMLElement;
    const text = root.querySelector('strong')!.firstChild!;
    expect(setInlineStep(root, select(text, 4, text, 10), 3)).toBe(true);
    expect(root.textContent).toBe('Earlier new result later.');
    expect(root.querySelector('[data-step="3"]')?.textContent).toBe('result');
    expect(root.querySelector('[data-step="3"] strong')?.textContent).toBe('result');
    expect(getSelection()?.toString()).toBe('result');
    // Ordinary typing within the run keeps its step in the saved HTML.
    root.querySelector('[data-step="3"] strong')!.textContent = 'finding';
    const saved = document.createElement('p');
    saved.innerHTML = root.innerHTML;
    expect(saved.querySelector('[data-step="3"]')?.textContent).toBe('finding');
  });

  it('changes and clears a selection inside an existing inline step without changing its neighbours', () => {
    const s = slide('<p><em data-step="5">alpha beta gamma</em></p>');
    const root = s.firstElementChild as HTMLElement;
    const text = root.querySelector('em')!.firstChild!;
    expect(setInlineStep(root, select(text, 6, text, 10), 2)).toBe(true);
    const chosen = root.querySelector('[data-step="2"]')!;
    expect(chosen.textContent).toBe('beta');
    expect(chosen.parentElement?.closest('[data-step]')).toBeNull();
    expect(Array.from(root.querySelectorAll('[data-step="5"]')).map(el => el.textContent)).toEqual(['alpha ', ' gamma']);
    expect(setInlineStep(root, getSelection(), 1)).toBe(true);
    expect(root.querySelector('[data-step="2"]')).toBeNull();
    expect(Array.from(root.querySelectorAll('[data-step="5"]')).map(el => el.textContent)).toEqual(['alpha ', ' gamma']);
    expect(root.textContent).toBe('alpha beta gamma');
  });

  it('leaves paragraph boundaries intact when a selection crosses them', () => {
    const s = slide('<div><p>First line</p><p><u>Second line</u></p></div>');
    const root = s.firstElementChild as HTMLElement;
    const first = root.querySelector('p')!.firstChild!;
    const last = root.querySelector('u')!.firstChild!;
    const original = root.innerHTML;
    expect(setInlineStep(root, select(first, 6, last, 6), 2)).toBe(false);
    expect(root.querySelectorAll('p')).toHaveLength(2);
    expect(root.querySelector('span p')).toBeNull();
    expect(root.innerHTML).toBe(original);
    expect(root.textContent).toBe('First lineSecond line');
  });

  it('does nothing for a caret, an outside selection or an invalid step', () => {
    const s = slide('<p>Keep this</p><p>Other</p>');
    const root = s.firstElementChild as HTMLElement;
    const original = root.innerHTML;
    expect(setInlineStep(root, select(root.firstChild!, 1, root.firstChild!, 1), 2)).toBe(false);
    expect(setInlineStep(root, select(s.lastElementChild!.firstChild!, 0, s.lastElementChild!.firstChild!, 2), 2)).toBe(false);
    expect(setInlineStep(root, select(root.firstChild!, 0, root.firstChild!, 4), 1.5)).toBe(false);
    expect(root.innerHTML).toBe(original);
  });
});

describe('PDF click steps', () => {
  it('expands slides in order with the same inline, object and list visibility as presenting', () => {
    const first = slide('<h1>One</h1><p>Fixed <span data-step="2">later</span></p><ul data-steps="2"><li>Item A</li><li data-step="-2">Item B</li></ul><div data-step="3">Object</div>');
    const second = slide('<h1>Two</h1><p>Always here</p>');
    const original = first.innerHTML;
    expandPrintSteps([first, second]);
    const pages = Array.from(document.querySelectorAll<HTMLElement>('.slide'));
    expect(pages).toHaveLength(4);
    expect(pages.map(p => p.querySelector('h1')!.textContent)).toEqual(['One', 'One', 'One', 'Two']);
    for (let i = 0; i < 3; i++) {
      const reference = document.createElement('section');
      reference.innerHTML = original;
      showSlideStep(reference, i + 1);
      expect(pages[i].innerHTML).toBe(reference.innerHTML);
    }
    expect(pages.map(p => p.querySelector('span')?.hasAttribute('data-ol-unshown'))).toEqual([true, false, false, undefined]);
  });

  it('retains dimmed steps in the PDF through the shared visibility styles', () => {
    visibilityCss();
    document.documentElement.classList.add('ol-steps-dim');
    const s = slide('<p>Now <strong data-step="2">later</strong></p>');
    expandPrintSteps([s]);
    expect(getComputedStyle(s.querySelector('strong')!).visibility).toBe('visible');
    expect(getComputedStyle(s.querySelector('strong')!).opacity).toBe('0.18');
  });

  it('rejects excessive page counts before changing the print document', () => {
    const s = slide('<p><span data-step="1001">Later</span></p>');
    const original = document.body.innerHTML;
    expect(() => expandPrintSteps([s])).toThrow('limited to 1000 pages');
    expect(document.body.innerHTML).toBe(original);
  });
});
