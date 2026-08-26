/**
 * Right-click menu of the text editor: context-sensitive entries for cross-references, labels,
 * citations, hyperlinks, child documents, graphics, insets and tracked changes, followed by the
 * usual editing / paragraph / insert commands.
 */
import type { EditorView } from 'prosemirror-view';
import { NodeSelection, TextSelection, type Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { paramMap, unquote } from '@overlyx/core';
import type { MenuItem } from './contextmenu';
import { editorContext, viewDocDir, viewProject } from './context';
import * as C from './commands';
import { changeAt, resolveChange } from './plugins/changes';
import { fileUrl, graphicsUrl } from '../api';
import { STANDARD_LAYOUTS } from './layouts';
import { resolveDocPath } from './context';

const REF_TYPES: [string, string][] = [
  ['ref', '<reference>'], ['eqref', '(<reference>)'], ['pageref', '<page>'], ['vref', '<reference> on page <page>'],
  ['vpageref', 'on page <page>'], ['formatted', 'Formatted reference'], ['nameref', 'Textual reference'], ['labelonly', 'Label only'],
];

function params(node: PMNode): Map<string, string> {
  try { return paramMap(JSON.parse(node.attrs.params || '[]')); } catch { return new Map(); }
}

function setParam(view: EditorView, pos: number, node: PMNode, key: string, value: string): void {
  const lines: string[] = JSON.parse(node.attrs.params || '[]');
  const idx = lines.findIndex(l => l.replace(/^\t/, '').startsWith(key + ' '));
  const line = `${key} ${value}`;
  if (idx >= 0) lines[idx] = line; else lines.splice(Math.max(0, lines.length - 1), 0, line);
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, params: JSON.stringify(lines) }));
}

const isMac = /Mac/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

export function editorContextMenu(view: EditorView, ev: MouseEvent): MenuItem[] {
  const state = view.state;
  const coords = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
  let target: { node: PMNode; pos: number } | null = null;
  if (coords) {
    if (coords.inside >= 0) {
      const n = state.doc.nodeAt(coords.inside);
      if (n && n.isInline && !n.isText) target = { node: n, pos: coords.inside };
    }
    const sel = state.selection;
    if (target) {
      if (!(sel instanceof NodeSelection && sel.from === target.pos)) view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, target.pos)));
    } else if (sel.empty || coords.pos < sel.from || coords.pos > sel.to) {
      try { view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(coords.pos)))); } catch { /* ignore */ }
    }
  }
  const items: MenuItem[] = [];
  const run = (cmd: Command) => () => { cmd(view.state, view.dispatch, view); view.focus(); };
  const dialog = (name: string, arg?: unknown) => () => editorContext.openDialog?.(name, arg);
  const project = viewProject(view), docDir = viewDocDir(view);

  if (target) {
    const { node, pos } = target;
    const p = params(node);
    if (node.type.name === 'command') {
      const cmd = String(node.attrs.cmd);
      if (cmd === 'ref') {
        const name = unquote(p.get('reference'));
        const cur = p.get('LatexCommand') ?? 'ref';
        items.push(
          { label: `Cross-reference to “${name}”`, info: true },
          { label: 'Go to label', shortcut: MOD + '+click', action: () => editorContext.gotoLabel?.(name.split(',')[0].trim(), view) },
          { label: 'Edit cross-reference…', shortcut: 'double-click', action: dialog('ref', { pos, node }) },
          { label: 'Reference format', sub: REF_TYPES.map(([k, l]) => ({ label: l, checked: cur === k, action: () => setParam(view, pos, node, 'LatexCommand', k) })) },
          { label: 'Copy label name', action: () => { void navigator.clipboard?.writeText(name); } },
          { sep: true },
        );
      } else if (cmd === 'label') {
        const name = unquote(p.get('name'));
        items.push(
          { label: `Label “${name}”`, info: true },
          { label: 'Edit label…', action: () => { const n = prompt('Label name:', name); if (n && n !== name) setParam(view, pos, node, 'name', `"${n}"`); } },
          { label: 'Insert cross-reference to this label…', action: dialog('ref', { prefill: name }) },
          { label: 'Copy label name', action: () => { void navigator.clipboard?.writeText(name); } },
          { sep: true },
        );
      } else if (cmd === 'citation') {
        const keys = unquote(p.get('key'));
        items.push(
          { label: `Citation ${keys}`, info: true },
          { label: 'Edit citation…', shortcut: 'double-click', action: dialog('cite', { pos, node }) },
          { label: 'Copy BibTeX key(s)', action: () => { void navigator.clipboard?.writeText(keys); } },
          { sep: true },
        );
      } else if (cmd === 'href') {
        const t = unquote(p.get('target'));
        items.push(
          { label: 'Hyperlink', info: true },
          { label: 'Open link in new browser tab', shortcut: MOD + '+click', action: () => window.open(/^[a-z]+:/i.test(t) ? t : 'https://' + t, '_blank', 'noopener') },
          { label: 'Edit hyperlink…', action: dialog('inset', pos) },
          { label: 'Copy link', action: () => { void navigator.clipboard?.writeText(t); } },
          { sep: true },
        );
      } else if (cmd === 'include') {
        const id = C.includeTarget(node, project, docDir);
        if (id) {
          items.push(
            { label: `Child document ${id.split('/').pop()}`, info: true },
            { label: 'Open in new tab', shortcut: MOD + '+click', action: () => editorContext.openInTab?.(id) },
            { label: 'Open in new tab (background)', action: () => editorContext.openInTab?.(id, { background: true }) },
            { label: 'Open in new browser tab', action: () => window.open('#/' + id, '_blank') },
            { label: 'Show master and child documents in one view', checked: editorContext.combined, action: () => editorContext.ui?.toggleCombined?.() },
            { sep: true },
          );
        }
      } else {
        items.push({ label: 'Settings…', action: dialog('inset', pos) }, { sep: true });
      }
    } else if (node.type.name === 'graphics') {
      const file = p.get('filename') ?? '';
      const rel = resolveDocPath(file, docDir);
      items.push(
        { label: `Graphics ${file}`, info: true },
        { label: 'Graphics settings…', shortcut: 'double-click', action: dialog('inset', pos) },
        { label: 'Open original in new browser tab', action: () => window.open(fileUrl(project, rel), '_blank') },
        { label: 'Export as PNG…', action: () => window.open(graphicsUrl(project, rel, 2400) + '&download=1', '_blank') },
        { sep: true },
      );
    } else if (node.type.name === 'macro') {
      items.push({ label: 'Math macro definition', info: true }, { label: 'Delete macro definition', action: () => { view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize)); } }, { sep: true });
    } else if (node.type.name === 'inset') {
      pushInsetItems(view, node, pos, items);
    } else if (node.type.name === 'table') {
      items.push({ label: 'Table', info: true }, { label: 'Table settings…', action: dialog('inset', pos) }, { sep: true });
    }
  }
  // enclosing inset (when not clicked on an inset itself)
  if (!target || target.node.type.name !== 'inset') {
    const parent = C.selectionParentInset(view.state);
    if (parent) pushInsetItems(view, parent.node, parent.pos, items);
  }
  // tracked change under the cursor
  const change = changeAt(view.state, view.state.selection.from);
  if (change) {
    const author = editorContext.meta?.authors.find(a => a.id === change.author)?.name ?? `author ${change.author}`;
    const when = change.time ? new Date(change.time * 1000).toLocaleString() : '';
    items.push(
      { label: `${change.type === 'deleted' ? 'Deleted' : 'Inserted'} by ${author}${when ? ' on ' + when : ''}`, info: true },
      { label: 'Accept change', action: run(resolveChange(change, true)) },
      { label: 'Reject change', action: run(resolveChange(change, false)) },
      { sep: true },
    );
  }
  // generic editing
  const hasSel = !view.state.selection.empty;
  items.push(
    { label: 'Cut', shortcut: MOD + '+X', disabled: !hasSel, action: () => { view.focus(); document.execCommand('cut'); } },
    { label: 'Copy', shortcut: MOD + '+C', disabled: !hasSel, action: () => { view.focus(); document.execCommand('copy'); } },
    { label: 'Paste', shortcut: MOD + '+V', action: () => { view.focus(); navigator.clipboard?.readText().then(t => { if (t) view.dispatch(view.state.tr.insertText(t)); }).catch(() => editorContext.notify?.('Use ' + MOD + '+V to paste', 'error')); } },
    { sep: true },
  );
  const layouts = (editorContext.meta?.layouts?.length ? editorContext.meta.layouts : STANDARD_LAYOUTS).slice(0, 40);
  const cur = C.currentParagraph(view.state);
  items.push(
    { label: 'Paragraph layout', sub: layouts.map(l => ({ label: l.name, checked: cur?.node.attrs.layout === l.name, action: run(C.setLayout(l.name)) })) },
    ...(C.tableContext(view.state) ? [{ label: 'Table settings…', action: () => editorContext.openDialog?.('tablesettings') }] : []),
    { label: 'Paragraph', sub: [
      { label: 'Paragraph settings…', shortcut: MOD + '+Alt+P', action: () => editorContext.openDialog?.('paragraph') },
      { sep: true },
      { label: 'Align left', action: run(C.setParagraphAttrs({ align: 'left' })) },
      { label: 'Align center', action: run(C.setParagraphAttrs({ align: 'center' })) },
      { label: 'Align right', action: run(C.setParagraphAttrs({ align: 'right' })) },
      { label: 'Justified', action: run(C.setParagraphAttrs({ align: 'block' })) },
      { label: 'Default alignment', action: run(C.setParagraphAttrs({ align: null })) },
      { sep: true },
      { label: 'Increase depth', shortcut: 'Alt+Shift+→', action: run(C.changeDepth(1)) },
      { label: 'Decrease depth', shortcut: 'Alt+Shift+←', action: run(C.changeDepth(-1)) },
    ] },
    { label: 'Insert', sub: [
      { label: 'Inline formula', shortcut: MOD + '+M', action: () => C.insertMath(false)(view) },
      { label: 'Display formula', shortcut: MOD + '+Shift+M', action: () => C.insertMath(true)(view) },
      { label: 'Numbered equation', action: () => C.insertMath(true, 'equation')(view) },
      { sep: true },
      { label: 'Footnote', action: run(C.insertFootnote) },
      { label: 'LyX note', action: run(C.insertNote('Note')) },
      { label: 'Comment thread', action: run(C.insertComment) },
      { sep: true },
      { label: 'Label…', action: dialog('label') },
      { label: 'Cross-reference…', action: dialog('ref') },
      { label: 'Citation…', action: dialog('cite') },
      { label: 'Graphics…', action: dialog('graphics') },
      { label: 'Table…', action: dialog('table') },
      { label: 'TeX code (ERT)', action: run(C.insertERT) },
    ] },
    { label: 'Track changes', sub: [
      { label: 'Track changes', checked: editorContext.trackChanges, action: () => editorContext.ui?.toggleTrackChanges() },
      { label: 'Accept all changes', action: () => editorContext.ui?.acceptAll?.() },
      { label: 'Reject all changes', action: () => editorContext.ui?.rejectAll?.() },
    ] },
  );
  return items;
}

function pushInsetItems(view: EditorView, node: PMNode, pos: number, items: MenuItem[]): void {
  const name = String(node.attrs.name), arg = String(node.attrs.arg ?? '');
  const nv = (view.nodeDOM(pos) as any)?.pmViewDesc?.spec as { toggle?: () => void; reply?: () => void; toggleResolved?: () => void } | undefined;
  const isComment = name === 'Note' && arg === 'Comment';
  items.push({ label: `${name}${arg ? ' ' + arg : ''} inset`, info: true });
  if (isComment && nv?.reply) items.push({ label: 'Reply to comment', action: () => nv.reply!() }, { label: 'Resolve / reopen thread', action: () => nv.toggleResolved!() });
  items.push(
    { label: node.attrs.status === 'collapsed' ? 'Open inset' : 'Close inset', shortcut: 'Ctrl+I', action: () => { if (nv?.toggle) nv.toggle(); else C.toggleInset(view.state, view.dispatch); } },
    { label: 'Inset settings…', shortcut: 'Ctrl+Alt+I', action: () => editorContext.openInsetDialog?.(view, pos) },
    { label: 'Dissolve inset', action: () => { C.dissolveInset(pos)(view.state, view.dispatch); view.focus(); } },
    { sep: true },
  );
}

