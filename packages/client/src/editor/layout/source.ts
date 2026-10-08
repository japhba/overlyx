/** Nonprinting LaTeX belongs to the editor chrome, never to a layout page's printed content. */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { toMm } from '@overlyx/core';

export function isLayoutSource(node: PMNode): boolean {
  return node.type.name === 'macro' || (node.type.name === 'inset' && ['ERT', 'Note'].includes(node.attrs.name));
}

/** A source-only paragraph must not leave an empty text line on paper. Mixed paragraphs keep their text. */
export function sourceOnlyParagraph(node: PMNode): boolean {
  if (!node.isTextblock || !node.childCount) return false;
  let source = false, printable = false;
  node.forEach(c => { if (isLayoutSource(c)) source = true; else if (!c.isText || c.text!.trim()) printable = true; });
  return source && !printable;
}

/** Apply an explicit \tabcolsep where it takes effect, instead of printing its setup command. */
export function layoutTableSpacing(box: PMNode): { pos: number; node: PMNode; mm: number }[] {
  const tables: { pos: number; node: PMNode; mm: number }[] = [];
  let spacing: number | null = null;
  box.descendants((node, pos) => {
    if (node.type.name === 'inset' && node.attrs.name === 'ERT') {
      for (const m of node.textContent.matchAll(/\\setlength\s*\{\s*\\tabcolsep\s*\}\s*\{([^}]+)\}/g)) spacing = toMm(m[1], 'pt');
      return false;
    }
    if (node.type.name === 'table') {
      if (spacing !== null) tables.push({ pos, node, mm: spacing });
      return false;
    }
    return true;
  });
  return tables;
}

export function layoutSources(page: PMNode): { label: string; latex: string }[] {
  const sources: { label: string; latex: string }[] = [];
  page.descendants(node => {
    if (node.type.name === 'ol_notes') return false;
    if (node.type.name === 'ol_raw') {
      sources.push({ label: node.attrs.name || (node.attrs.placed === false ? 'Page LaTeX' : 'LaTeX object'), latex: node.attrs.latex });
      return false;
    }
    if (!isLayoutSource(node)) return true;
    const latex = node.type.name === 'macro' ? (JSON.parse(node.attrs.lines) as string[]).join('\n') : node.content.content.map(p => p.textContent).join('\n');
    sources.push({ label: node.type.name === 'macro' ? 'Macro definition' : node.attrs.name === 'ERT' ? 'LaTeX fragment' : 'Editor note', latex });
    return false;
  });
  return sources;
}

/** Read the current page, so edits / reordered slides cannot leave this inspector showing stale source. */
export function openLayoutSources(view: EditorView, pos: number): void {
  const page = view.state.doc.nodeAt(pos)!;
  const back = document.createElement('div');
  back.className = 'dialog-backdrop';
  const box = document.createElement('div');
  box.className = 'dialog wide ol-source-dialog';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Slide LaTeX');
  const title = document.createElement('h2');
  title.textContent = 'Slide LaTeX';
  const body = document.createElement('div');
  body.className = 'body';
  const hint = document.createElement('p');
  hint.className = 'dialog-hint';
  hint.textContent = 'These fragments stay in the .tex file. Edit them in the LaTeX source pane; LaTeX objects also have a double-click editor.';
  body.append(hint);
  for (const source of layoutSources(page)) {
    const label = document.createElement('h3');
    label.textContent = source.label;
    const code = document.createElement('pre');
    code.className = 'ol-source-code';
    code.textContent = source.latex;
    body.append(label, code);
  }
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const done = document.createElement('button');
  done.type = 'button'; done.className = 'btn primary'; done.textContent = 'Close';
  buttons.append(done);
  box.append(title, body, buttons);
  back.append(box);
  document.body.append(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); view.focus(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } e.stopPropagation(); };
  document.addEventListener('keydown', onKey, true);
  done.addEventListener('click', close);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  done.focus();
}
