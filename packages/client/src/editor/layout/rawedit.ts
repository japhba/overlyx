/**
 * Editing the LaTeX of a raw object (TikZ, pgfplots, \qrcode …): a small dialog with the source,
 * applied with Ctrl+Enter; the object then shows its newly typeset image. Plain DOM with the app's
 * dialog styles, so both shells have it.
 */
import type { EditorView } from 'prosemirror-view';
import { setAttrs } from './commands';

export function openRawEditor(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'ol_raw') return;
  const back = document.createElement('div');
  back.className = 'dialog-backdrop';
  const box = document.createElement('div');
  box.className = 'dialog wide ol-rawedit';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const h = document.createElement('h2');
  h.textContent = 'LaTeX of this object';
  const hint = document.createElement('p');
  hint.className = 'dialog-hint';
  hint.textContent = 'Typeset with the document’s own preamble, in a box of the object’s size. Ctrl+Enter applies.';
  const ta = document.createElement('textarea');
  ta.value = String(node.attrs.latex ?? '');
  ta.spellcheck = false;
  ta.className = 'ol-rawedit-code';
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const apply = document.createElement('button');
  apply.className = 'btn primary';
  apply.textContent = 'Apply';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  buttons.append(apply, cancel);
  const body = document.createElement('div');
  body.className = 'body';
  body.append(hint, ta);
  box.append(h, body, buttons);
  back.append(box);
  document.body.append(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); view.focus(); };
  const commit = () => {
    const cur = view.state.doc.nodeAt(pos);
    if (cur && cur.type.name === 'ol_raw' && cur.attrs.latex !== ta.value) view.dispatch(setAttrs(view.state.tr, pos, { latex: ta.value }));
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopImmediatePropagation(); commit(); }
    else e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  apply.addEventListener('click', commit);
  cancel.addEventListener('click', close);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  ta.focus();
}
