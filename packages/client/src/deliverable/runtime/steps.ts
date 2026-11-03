/** The same overlay rules for presenting and PDF click steps, including inline text. */
import { parseSteps, stepOf, stepVisible, lastStep, type Interval } from '@overlyx/core/html/steps.ts';

export const STEP_VISIBILITY_CSS = `[data-ol-unshown] { visibility: hidden !important; }
  html.ol-steps-dim [data-ol-unshown] { visibility: visible !important; opacity: .18 !important; }`;

/** Any descendant may have an overlay: objects, drawing parts, inline spans and list items. */
export function stepElements(slide: Element): [Element, Interval[]][] {
  const out: [Element, Interval[]][] = [];
  for (const el of Array.from(slide.querySelectorAll('[data-step]'))) out.push([el, parseSteps(el.getAttribute('data-step'))]);
  for (const list of Array.from(slide.querySelectorAll(':is(ul, ol)[data-steps]'))) {
    const first = stepOf(list.getAttribute('data-steps'));
    const items = Array.from(list.children).filter(c => c.localName === 'li');
    items.forEach((li, i) => { if (!li.hasAttribute('data-step') && first + i > 1) out.push([li, [[first + i, null]]]); });
  }
  return out;
}

export const slideStepCount = (slide: Element | undefined): number => slide ? lastStep(stepElements(slide).map(([, iv]) => iv)) : 1;

export function showSlideStep(slide: Element, step: number): void {
  for (const el of Array.from(slide.querySelectorAll('[data-ol-unshown]'))) el.removeAttribute('data-ol-unshown');
  for (const [el, iv] of stepElements(slide)) if (!stepVisible(iv, step)) el.setAttribute('data-ol-unshown', '');
}

/** Called only in the disposable print page, after fonts, formulas and figures have settled. */
export function expandPrintSteps(slides: HTMLElement[]): void {
  const counts = slides.map(slideStepCount);
  // Check before cloning: a mistyped overlay must not allocate unbounded PDF pages.
  const pages = counts.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(pages) || pages > 1000) throw new Error('PDF with click steps is limited to 1000 pages.');
  slides.forEach((slide, i) => {
    const copies = slide.ownerDocument.createDocumentFragment();
    for (let step = 2; step <= counts[i]; step++) {
      const copy = slide.cloneNode(true) as HTMLElement;
      // cloneNode copies SVGs and typeset math; canvases need their painted pixels too.
      const canvases = slide.querySelectorAll('canvas');
      copy.querySelectorAll('canvas').forEach((canvas, n) => canvas.getContext('2d')?.drawImage(canvases[n], 0, 0));
      showSlideStep(copy, step);
      copies.append(copy);
    }
    slide.after(copies);
    showSlideStep(slide, 1);
  });
}
