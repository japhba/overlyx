/** A preamble-based title is a preview: editing its definitions happens in the preamble. */
import { DOMSerializer } from 'prosemirror-model';
import { paragraphsToPm, schema, type Paragraph } from '@overlyx/core';

export function renderTitlePreview(dom: HTMLElement, paragraphs: Paragraph[], renderMath: (el: HTMLElement, latex: string, display: boolean) => void): void {
  const doc = schema.nodeFromJSON({ type: 'doc', content: paragraphsToPm(paragraphs) });
  dom.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  // Use the editor's normal math rendering, including document macros.
  for (const el of dom.querySelectorAll<HTMLElement>('[data-latex]')) renderMath(el, el.dataset.latex ?? '', el.classList.contains('lyx-math-display'));
  // Keep today's date dynamic without putting a clock-dependent value into the document model.
  for (const el of dom.querySelectorAll<HTMLElement>('.lyx-inset[data-name="ERT"]')) {
    if (el.textContent?.trim() === '\\today') el.replaceWith(document.createTextNode(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })));
  }
}
