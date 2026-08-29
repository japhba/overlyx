/**
 * Static rendering of editor nodes outside the editor: the AI ghost text and the rewrite preview
 * show the proposed content the way it will look once inserted — formulas through KaTeX, cross
 * references and citations as the text they stand for.
 */
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema } from '@overlyx/core';
import { renderStaticHtml } from '../lyxmath/field';
import { macroTableFor } from '../lyxmath/macrotable';
import { nodeText } from '../cliptext';

let serializer: DOMSerializer | null = null;

/** DOM for a fragment of editor nodes at document position `pos` (the macros in force there apply). */
export function renderFragment(view: EditorView, frag: Fragment, pos: number | undefined): HTMLElement | DocumentFragment {
  serializer ??= DOMSerializer.fromSchema(schema);
  const dom = serializer.serializeFragment(frag);
  const { table } = macroTableFor(view, pos);
  dom.querySelectorAll('.lyx-math-inline').forEach(el => { el.innerHTML = renderStaticHtml('$' + (el.getAttribute('data-latex') ?? '') + '$', false, table); });
  dom.querySelectorAll('.lyx-math-display').forEach(el => { el.innerHTML = renderStaticHtml(el.getAttribute('data-latex') ?? '', true, table); });
  // leaf nodes render through node views in the editor; here they show their plain-text form
  const leaves: PMNode[] = [];
  frag.descendants(n => { if (n.type.name === 'command' || n.type.name === 'graphics') leaves.push(n); return true; });
  dom.querySelectorAll('.lyx-command, .lyx-graphics').forEach((el, i) => { const n = leaves[i]; if (n) el.textContent = nodeText(n) || `[${n.attrs.cmd ?? n.type.name}]`; });
  return dom;
}

/** Whether a fragment is inline content (text, formulas, …) as opposed to whole paragraphs. */
export function isInlineFragment(frag: Fragment): boolean {
  return !!frag.firstChild && frag.firstChild.isInline;
}
