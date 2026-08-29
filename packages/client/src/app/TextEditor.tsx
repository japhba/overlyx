/**
 * A simple editor for the project's text files (.tex, .bib, .sty, …): plain textarea with line
 * numbers, autosave (1.5 s after the last change, or Ctrl+S), and a conflict check — a save is
 * refused when the file changed on the server in the meantime (someone else, desktop LyX, git).
 * A coloured copy of the text lies under the (transparent) textarea (texhighlight.ts), which also
 * marks the bracket pair at the cursor and the current line; undo / redo and the editing keys
 * (auto-closing brackets, Enter with indentation and \end completion, Ctrl+/, Alt+↑↓, …) are our
 * own (codearea.ts).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, fileUrl, type Role } from '../api';
import { highlightTex } from './texhighlight';
import { UndoStack, undoRedoKey, applyUndoRedo, applySnapshot, editingKey, matchBrackets, commentMask, type Snapshot } from './codearea';

type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'conflict' | 'error' | 'readonly';
const LABEL: Record<SaveState, string> = { loading: 'Loading…', saved: '✓ Saved', dirty: 'Unsaved changes…', saving: 'Saving…', conflict: 'Not saved — changed on the server', error: 'Could not save', readonly: '👁 view only' };

export function TextEditor({ id, notify }: { id: string; notify: (text: string, kind?: 'info' | 'error') => void }) {
  const project = id.split('/')[0];
  const path = id.slice(project.length + 1);
  const [text, setText] = useState('');
  const [state, setState] = useState<SaveState>('loading');
  const [err, setErr] = useState('');
  const [conflict, setConflict] = useState<{ text: string; mtime: number } | null>(null);
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const role = useRef<Role>('edit');
  const mtime = useRef(0);
  const dirty = useRef(false);
  const latest = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const undo = useRef(new UndoStack({ value: '', start: 0, end: 0 }));
  /** cursor offset when nothing is selected (for bracket matching), else null */
  const [cursor, setCursor] = useState<number | null>(null);
  const mask = useMemo(() => commentMask(text), [text]);
  const match = useMemo(() => (cursor === null ? null : matchBrackets(text, cursor, mask)), [text, cursor, mask]);
  const html = useMemo(() => {
    let marks: Map<number, string> | undefined;
    if (match) {
      marks = new Map();
      const cls = match.kind === 'adjacent' ? 'hl-match' : 'hl-enclose';
      for (const at of [match.open, match.close]) for (let k = 0; k < match.len; k++) marks.set(at + k, cls);
    }
    return highlightTex(text, marks) + '\n';
  }, [text, match]);

  const load = async () => {
    try {
      const r = await api.readText(project, path);
      latest.current = r.text; setText(r.text); mtime.current = r.mtime; role.current = r.role;
      undo.current.reset({ value: r.text, start: 0, end: 0 });
      dirty.current = false; setConflict(null); setErr('');
      setState(r.role === 'view' ? 'readonly' : 'saved');
    } catch (e) { setErr((e as Error).message); setState('error'); }
  };

  const save = async (force = false) => {
    if (role.current === 'view' || (!dirty.current && !force)) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setState('saving');
    const snapshot = latest.current;
    try {
      const r = await api.writeText(project, path, snapshot, force ? undefined : mtime.current);
      mtime.current = r.mtime; setConflict(null);
      if (latest.current === snapshot) { dirty.current = false; setState('saved'); } else { setState('dirty'); schedule(); }
    } catch (e) {
      const err = e as Error & { status?: number; data?: { text?: string; mtime?: number } };
      if (err.status === 409 && err.data && typeof err.data.text === 'string') { setConflict({ text: err.data.text, mtime: err.data.mtime ?? 0 }); setState('conflict'); }
      else { setErr(err.message); setState('error'); notify('Could not save ' + path + ': ' + err.message, 'error'); }
    }
  };
  const schedule = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void save(), 1500); };

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      // leaving the tab with unsaved text: write it now (best effort)
      if (dirty.current && role.current !== 'view') void api.writeText(project, path, latest.current, mtime.current).catch(() => {});
    };
  }, [id]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  /** the textarea holds new text (typed, undone, pasted): keep it, schedule the save */
  const changed = (v: string) => {
    latest.current = v; setText(v); dirty.current = true;
    if (state !== 'conflict') { setState('dirty'); schedule(); }
    updatePos();
  };
  const onInput = (e: Event) => {
    const el = e.target as HTMLTextAreaElement;
    undo.current.record({ value: el.value, start: el.selectionStart, end: el.selectionEnd });
    changed(el.value);
  };
  const updatePos = () => {
    const el = ta.current; if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const line = before.split('\n').length;
    setPos({ line, col: before.length - before.lastIndexOf('\n') });
    setCursor(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };
  // the cursor moved (also by the mouse, Shift+arrows, …): the bracket match follows
  useEffect(() => {
    const h = () => { if (document.activeElement === ta.current) updatePos(); };
    document.addEventListener('selectionchange', h);
    return () => document.removeEventListener('selectionchange', h);
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(dirty.current); if (!dirty.current) notify('Nothing to save'); return; }
    const ur = undoRedoKey(e);
    if (ur) {
      e.preventDefault();
      if (role.current === 'view') return;
      const s = applyUndoRedo(ta.current!, undo.current, ur);
      if (s) changed(s.value);
      return;
    }
    if (role.current === 'view' || e.isComposing) return;
    const el = ta.current!;
    const s = editingKey(e, el);
    if (s) { e.preventDefault(); applySnapshot(el, s); onInput({ target: el } as unknown as Event); }
  };
  // the current line, marked in the overlay (its height is the overlay's line height)
  const [lineH, setLineH] = useState(0);
  useEffect(() => { if (pre.current) setLineH(parseFloat(getComputedStyle(pre.current).lineHeight) || 0); }, []);
  const syncScroll = (el: HTMLTextAreaElement) => {
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
    if (pre.current) { pre.current.scrollTop = el.scrollTop; pre.current.scrollLeft = el.scrollLeft; }
  };
  /** the text was replaced wholesale (the server's version): an undoable step */
  const replaceText = (v: string) => { const el = ta.current; const s: Snapshot = { value: v, start: 0, end: 0 }; undo.current.record(s); if (el) { el.value = v; el.setSelectionRange(0, 0); } latest.current = v; setText(v); };
  const lines = text.split('\n').length;
  const readonly = state === 'readonly' || state === 'loading' || state === 'error';

  return (
    <div class="text-editor" data-text-editor={id}>
      <div class="te-head">
        <span class="path" title={id}>📝 {path}</span>
        <span class={'state ' + state} data-state={state}>{LABEL[state]}{state === 'error' && err ? ': ' + err : ''}</span>
        <span class="spacer" />
        <span title="Line and column of the cursor">Ln {pos.line}, Col {pos.col} · {lines} lines</span>
        <button class="small-btn" title="Reload from the server" onClick={() => { if (!dirty.current || confirm('Discard your unsaved changes and reload?')) void load(); }}>↻ Reload</button>
        <a class="small-btn" href={fileUrl(project, path)} download={path.split('/').pop()} title="Download this file">⬇</a>
      </div>
      {conflict && (
        <div class="te-conflict">
          <span>This file was changed on the server while you were editing (by someone else, desktop LyX or git).</span>
          <button class="small-btn" onClick={() => { replaceText(conflict.text); mtime.current = conflict.mtime; dirty.current = false; setConflict(null); setState('saved'); }}>Take the server's version</button>
          <button class="small-btn" onClick={() => void save(true)}>Overwrite with mine</button>
        </div>
      )}
      <div class="te-body">
        <div class="te-gutter" ref={gutter} aria-hidden="true">{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</div>
        <div class={'te-code' + (readonly ? ' readonly' : '')}>
          <pre class="hl" ref={pre} aria-hidden="true">
            {lineH > 0 && cursor !== null && <span class="cur" style={{ top: 8 + (pos.line - 1) * lineH + 'px', height: lineH + 'px' }} />}
            <code dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
          <textarea ref={ta} value={text} spellcheck={false} readOnly={readonly} wrap="off" autocomplete="off" autocorrect="off" autocapitalize="off"
            onInput={onInput} onKeyDown={onKeyDown} onClick={updatePos} onKeyUp={updatePos}
            onScroll={e => syncScroll(e.target as HTMLTextAreaElement)} />
        </div>
      </div>
    </div>
  );
}
