/**
 * Source pane: the LyX source of the document under the cursor (generated live from the editor
 * state) or the exported LaTeX. The LyX source is editable — "Apply" parses it and replaces the
 * document content (and header) through the normal collaborative channel.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type * as Y from 'yjs';
import { parseLyx, writeLyx, lyxToPm, pmToLyxBody, schema } from '@overlyx/core';
import { api } from '../api';

export interface SourceTarget { view: EditorView; ydoc: Y.Doc; docId: string }

function metaOf(ydoc: Y.Doc) {
  const m = ydoc.getMap<string>('meta');
  const parse = (k: string, def: unknown) => { try { const v = m.get(k); return v ? JSON.parse(v) : def; } catch { return def; } };
  return {
    preamble: parse('preamble', ['#LyX 2.5 created this file. For more info see https://www.lyx.org/']) as string[],
    format: parse('format', 643) as number,
    header: parse('header', []) as string[],
    trailer: parse('trailer', []) as string[],
  };
}

export function generateLyx(t: SourceTarget): string {
  const meta = metaOf(t.ydoc);
  return writeLyx({ preamble: meta.preamble, format: meta.format, header: { lines: meta.header }, body: pmToLyxBody(t.view.state.doc), trailer: meta.trailer });
}

/** Index (in document order) of the innermost paragraph containing the selection → the n-th \begin_layout. */
function paragraphIndex(view: EditorView): number {
  const $from = view.state.selection.$from;
  let target = -1;
  for (let d = $from.depth; d >= 0; d--) if ($from.node(d).type.name === 'paragraph') { target = $from.before(d); break; }
  if (target < 0 && view.state.selection instanceof NodeSelection) target = view.state.selection.from;
  if (target < 0) return -1;
  let idx = -1, n = 0;
  view.state.doc.descendants((node, pos) => {
    if (idx >= 0) return false;
    if (node.type.name === 'paragraph') { if (pos >= target) { idx = n; return false; } n++; }
    return true;
  });
  return idx;
}

function lineOfParagraph(text: string, idx: number): number {
  if (idx < 0) return -1;
  let line = 0, count = -1;
  const lines = text.split('\n');
  for (; line < lines.length; line++) {
    if (lines[line].startsWith('\\begin_layout')) { count++; if (count === idx) return line; }
  }
  return -1;
}

export function SourcePane({ target, tick, selTick, onNotify }: { target: SourceTarget | null; tick: number; selTick: number; onNotify: (msg: string, kind?: 'info' | 'error') => void }) {
  const [mode, setMode] = useState<'lyx' | 'latex'>('lyx');
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [latex, setLatex] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState(-1);
  const ta = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // regenerate the LyX source when the document changes (unless the user is editing the source)
  useEffect(() => {
    if (!target || dirty) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { try { setText(generateLyx(target)); } catch (e) { setText('% could not generate source: ' + (e as Error).message); } }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [target?.docId, tick, dirty]);

  // follow the cursor: scroll to the \begin_layout of the current paragraph
  useEffect(() => {
    if (!target || dirty || mode !== 'lyx') return;
    const l = lineOfParagraph(text, paragraphIndex(target.view));
    setLine(l);
    const el = ta.current;
    if (el && l >= 0 && document.activeElement !== el) {
      const lh = 15;
      const y = l * lh - el.clientHeight / 3;
      el.scrollTop = Math.max(0, y);
      // highlight the line through the selection (does not steal focus)
      const start = text.split('\n').slice(0, l).join('\n').length + (l > 0 ? 1 : 0);
      const end = start + (text.split('\n')[l]?.length ?? 0);
      try { el.setSelectionRange(start, end); } catch { /* ignore */ }
    }
  }, [selTick, text, mode]);

  const loadLatex = async () => {
    if (!target) return;
    setBusy(true);
    try { const r = await api.export(target.docId, 'tex'); setLatex(r.tex ?? ''); } catch (e) { setLatex('% export failed: ' + (e as Error).message); }
    setBusy(false);
  };
  useEffect(() => { if (mode === 'latex' && !latex) void loadLatex(); }, [mode, target?.docId]);

  const apply = () => {
    if (!target) return;
    try {
      const doc = parseLyx(text);
      const pm = schema.nodeFromJSON(lyxToPm(doc));
      const { view, ydoc } = target;
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, pm.content);
      view.dispatch(tr.setSelection(TextSelection.atStart(tr.doc)));
      const m = ydoc.getMap<string>('meta');
      const cur = metaOf(ydoc);
      ydoc.transact(() => {
        if (JSON.stringify(cur.header) !== JSON.stringify(doc.header.lines)) m.set('header', JSON.stringify(doc.header.lines));
        if (JSON.stringify(cur.preamble) !== JSON.stringify(doc.preamble)) m.set('preamble', JSON.stringify(doc.preamble));
        if (JSON.stringify(cur.trailer) !== JSON.stringify(doc.trailer)) m.set('trailer', JSON.stringify(doc.trailer));
        if (cur.format !== doc.format) m.set('format', JSON.stringify(doc.format));
      });
      setDirty(false);
      onNotify('Source applied to the document');
    } catch (e) {
      onNotify('Cannot apply source: ' + (e as Error).message, 'error');
    }
  };
  const revert = () => { setDirty(false); if (target) setText(generateLyx(target)); };

  const name = target?.docId.split('/').pop() ?? '';
  return (
    <div class="source-pane">
      <div class="bar">
        <button class={'small-btn' + (mode === 'lyx' ? ' active' : '')} onClick={() => setMode('lyx')} title="LyX file source (editable)">LyX</button>
        <button class={'small-btn' + (mode === 'latex' ? ' active' : '')} onClick={() => setMode('latex')} title="Exported LaTeX (read-only)">LaTeX</button>
        <span class="name" title={target?.docId}>{name}</span>
        <span style="flex:1" />
        {mode === 'lyx' && dirty && <button class="small-btn primary" onClick={apply} title="Parse the edited source and replace the document">Apply</button>}
        {mode === 'lyx' && dirty && <button class="small-btn" onClick={revert}>Revert</button>}
        {mode === 'lyx' && !dirty && line >= 0 && <span class="line">line {line + 1}</span>}
        {mode === 'latex' && <button class="small-btn" disabled={busy} onClick={loadLatex}>{busy ? '…' : 'Refresh'}</button>}
        <button class="small-btn" onClick={() => { void navigator.clipboard?.writeText(mode === 'lyx' ? text : latex); }} title="Copy to clipboard">Copy</button>
      </div>
      {mode === 'lyx'
        ? <textarea ref={ta} class="source" spellcheck={false} value={text} onInput={e => { setText((e.target as HTMLTextAreaElement).value); setDirty(true); }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && dirty) { e.preventDefault(); apply(); } }} />
        : <textarea class="source" spellcheck={false} value={latex} readOnly />}
      {mode === 'lyx' && <div class="hint">{dirty ? 'Edited — Apply (Ctrl+Enter) replaces the document with this source.' : 'Live LyX source of the document. Edit and apply, or copy.'}</div>}
    </div>
  );
}
